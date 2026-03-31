#!/usr/bin/env node
/**
 * MCP server for executing local Mathematica (Wolfram Script) code and returning the output.
 * This server helps check mathematical derivations and can generate LaTeX output from LLMs.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
// Promisify exec for async/await usage
const execAsync = promisify(exec);
const PROTECTED_SYMBOL_RENAMES = {
    D: "Dval",
    I: "Ival",
    E: "Eval",
    N: "Nval",
};
const moduleDir = dirname(fileURLToPath(import.meta.url));
const promptsConfigPath = resolve(moduleDir, "../config/prompts.json");
const resourcesConfigPath = resolve(moduleDir, "../config/resources.json");
let promptTemplatesCache = null;
let referenceResourcesCache = null;
async function loadPromptTemplates() {
    if (promptTemplatesCache) {
        return promptTemplatesCache;
    }
    const raw = await readFile(promptsConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
        throw new Error("prompts.json must be an object keyed by template name");
    }
    const templates = parsed;
    for (const [name, template] of Object.entries(templates)) {
        if (!template || typeof template.description !== "string" || typeof template.template !== "string" || !Array.isArray(template.requiredParams)) {
            throw new Error(`Invalid prompt template definition for "${name}"`);
        }
    }
    promptTemplatesCache = templates;
    return templates;
}
async function loadReferenceResources() {
    if (referenceResourcesCache) {
        return referenceResourcesCache;
    }
    const raw = await readFile(resourcesConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error("resources.json must be an array");
    }
    for (const entry of parsed) {
        if (!entry || typeof entry !== "object") {
            throw new Error("Invalid resource entry");
        }
        const resource = entry;
        if (typeof resource.id !== "string" ||
            typeof resource.title !== "string" ||
            typeof resource.description !== "string" ||
            typeof resource.content !== "string") {
            throw new Error(`Invalid resource schema for "${resource.id ?? "unknown"}"`);
        }
    }
    referenceResourcesCache = parsed;
    return referenceResourcesCache;
}
async function reloadPromptAndResourceConfigs() {
    promptTemplatesCache = null;
    referenceResourcesCache = null;
    const templates = await loadPromptTemplates();
    const resources = await loadReferenceResources();
    return {
        promptCount: Object.keys(templates).length,
        resourceCount: resources.length,
    };
}
async function diagnoseMcpCapabilities() {
    const diagnostics = {
        promptsConfigPath,
        resourcesConfigPath,
        promptsCacheLoaded: promptTemplatesCache !== null,
        resourcesCacheLoaded: referenceResourcesCache !== null,
    };
    try {
        const templates = await loadPromptTemplates();
        diagnostics.promptCount = Object.keys(templates).length;
        diagnostics.promptTemplateNames = Object.keys(templates);
    }
    catch (error) {
        diagnostics.promptsLoadError = error?.message ?? String(error);
    }
    try {
        const resources = await loadReferenceResources();
        diagnostics.resourceCount = resources.length;
        diagnostics.resourceIds = resources.map((resource) => resource.id);
    }
    catch (error) {
        diagnostics.resourcesLoadError = error?.message ?? String(error);
    }
    diagnostics.status =
        diagnostics.promptsLoadError || diagnostics.resourcesLoadError
            ? "degraded"
            : "ok";
    return diagnostics;
}
async function renderPromptTemplate(templateName, params) {
    const templates = await loadPromptTemplates();
    const template = templates[templateName];
    if (!template) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown prompt template: ${templateName}`);
    }
    for (const requiredParam of template.requiredParams) {
        if (!params[requiredParam]) {
            throw new McpError(ErrorCode.InvalidParams, `Missing required template param: ${requiredParam}`);
        }
    }
    return template.template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, name) => {
        return params[name] ?? "";
    });
}
const formatToolError = (code, summary, hint, details) => {
    return [
        `ErrorCode: ${code}`,
        `Summary: ${summary}`,
        `Hint: ${hint}`,
        details ? `Details: ${details}` : "",
    ]
        .filter(Boolean)
        .join("\n");
};
function preprocessMathematicaCode(rawCode) {
    let code = rawCode.normalize("NFC");
    const rewrites = [];
    const blockedByRecursion = [];
    const codeForChecks = code.replace(/\(\*[\s\S]*?\*\)/g, " ");
    const symbolNormalizationRules = [
        [/Î±|α/g, "alpha", "alpha-symbol -> alpha"],
        [/Ï|τ/g, "tau", "tau-symbol -> tau"],
        [/Îº|κ/g, "kappa", "kappa-symbol -> kappa"],
        [/̃/g, "", "removed combining-tilde"],
        [/∂/g, "D", "partial-symbol -> D"],
    ];
    for (const [pattern, replacement, rewriteLabel] of symbolNormalizationRules) {
        if (pattern.test(code)) {
            code = code.replace(pattern, replacement);
            rewrites.push(rewriteLabel);
        }
    }
    for (const [symbol, replacement] of Object.entries(PROTECTED_SYMBOL_RENAMES)) {
        const assignmentRegex = new RegExp(`(^|[;\\n])\\s*${symbol}\\s*=`, "m");
        if (!assignmentRegex.test(codeForChecks)) {
            continue;
        }
        // Keep derivative calls like D[...] untouched while renaming variable usage.
        const symbolUsage = new RegExp(`\\b${symbol}\\b(?!\\s*\\[)`, "g");
        code = code.replace(symbolUsage, replacement);
        rewrites.push(`${symbol} -> ${replacement}`);
    }
    const recursiveAssignmentRegex = /(^|[;\n])\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*\2\s*\[/gm;
    let match;
    while ((match = recursiveAssignmentRegex.exec(codeForChecks)) !== null) {
        blockedByRecursion.push(match[2]);
    }
    return { code, rewrites, blockedByRecursion };
}
function normalizeMathInput(text, mode = "mixed") {
    let normalizedText = text.normalize("NFC").trim();
    const warnings = [];
    const detectedIssues = [];
    const modeLower = mode.toLowerCase();
    if (!["latex", "mixed", "mathematica"].includes(modeLower)) {
        warnings.push(`Unknown mode "${mode}". Falling back to "mixed".`);
    }
    if (/\\[A-Za-z]/.test(normalizedText)) {
        detectedIssues.push("Contains LaTeX-style escape sequences.");
    }
    if (/[²³]/.test(normalizedText)) {
        detectedIssues.push("Contains Unicode superscripts.");
    }
    if (/(^|[\n;])\s*(D|I|E|N)\s*=/.test(normalizedText)) {
        detectedIssues.push("Contains assignment to protected Mathematica symbol.");
    }
    if (/(^|[\n;])\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*\2\s*\[/.test(normalizedText)) {
        detectedIssues.push("Contains potential self-referential assignment.");
    }
    normalizedText = normalizedText
        .replace(/²/g, "^2")
        .replace(/³/g, "^3");
    // Lightweight LaTeX normalization, intentionally conservative.
    if (modeLower === "latex" || modeLower === "mixed" || !["latex", "mixed", "mathematica"].includes(modeLower)) {
        normalizedText = normalizedText
            .replace(/\\tilde\{\\kappa\}/g, "kappaTilde")
            .replace(/\\kappa/g, "kappa")
            .replace(/\\alpha/g, "alpha")
            .replace(/\\tau/g, "tau")
            .replace(/\\partial/g, "D")
            .replace(/∂/g, "D")
            .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "(($1)/($2))");
    }
    for (const [symbol, replacement] of Object.entries(PROTECTED_SYMBOL_RENAMES)) {
        const assignmentRegex = new RegExp(`(^|[;\\n])\\s*${symbol}\\s*=`, "m");
        if (!assignmentRegex.test(normalizedText)) {
            continue;
        }
        const symbolUsage = new RegExp(`\\b${symbol}\\b(?!\\s*\\[)`, "g");
        normalizedText = normalizedText.replace(symbolUsage, replacement);
        warnings.push(`Auto-rewrote protected symbol ${symbol} -> ${replacement}.`);
    }
    return {
        normalizedText,
        warnings,
        detectedIssues,
    };
}
function isInstructionText(text, instructionKeywords = []) {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    const builtInMatch = /^(given|also given|assume|let|find|compute|show|prove|derive|verify|we want to find|step\s*\d+:)/.test(lower) ||
        /^(求|证明|化简|计算|推导|求解|表示|验证|说明|写出|推断|确定|解出)/.test(trimmed);
    if (builtInMatch) {
        return true;
    }
    return instructionKeywords.some((keyword) => {
        const k = keyword.trim();
        if (!k)
            return false;
        return lower.startsWith(k.toLowerCase()) || trimmed.startsWith(k);
    });
}
function classifyStepKind(text, instructionKeywords = []) {
    const trimmed = text.trim();
    if (!trimmed)
        return "unknown";
    if (isInstructionText(trimmed, instructionKeywords)) {
        return "instruction";
    }
    if (/(==|=)/.test(trimmed)) {
        return "equation";
    }
    if (/[A-Za-z0-9\]\)]/.test(trimmed)) {
        return "expression";
    }
    return "unknown";
}
async function analyzeMathStep(text, mode = "mixed", instructionKeywords = []) {
    const normalized = normalizeMathInput(text, mode);
    const kind = classifyStepKind(normalized.normalizedText, instructionKeywords);
    // Skip parser calls for clear instruction/unknown lines.
    if (kind === "instruction" || kind === "unknown") {
        return {
            kind,
            originalText: text,
            normalizedText: normalized.normalizedText,
            parseable: false,
            warnings: normalized.warnings,
            detectedIssues: normalized.detectedIssues,
        };
    }
    const escaped = normalized.normalizedText
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
    const parseProbeCode = `
    input = "${escaped}";
    parsed = Quiet @ Check[
      ToExpression[input, InputForm, HoldComplete],
      $Failed
    ];
    If[parsed === $Failed, "False", "True"]
  `;
    let parseable = false;
    try {
        const parseProbe = await executeMathematicaCode(parseProbeCode, "text");
        parseable = parseProbe.trim() === "True";
    }
    catch {
        parseable = false;
    }
    return {
        kind,
        originalText: text,
        normalizedText: normalized.normalizedText,
        parseable,
        warnings: normalized.warnings,
        detectedIssues: normalized.detectedIssues,
    };
}
async function differentiateSymbolic(expression, variable, assumptions = "True", format = "text", mode = "mixed") {
    const normalizedExpression = normalizeMathInput(expression, mode).normalizedText;
    const normalizedVariable = normalizeMathInput(variable, mode).normalizedText;
    const normalizedAssumptions = assumptions.trim()
        ? normalizeMathInput(assumptions, mode).normalizedText
        : "True";
    const escapedExpression = normalizedExpression.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const escapedVariable = normalizedVariable.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const escapedAssumptions = normalizedAssumptions.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const code = `
    exprHeld = Quiet @ Check[ToExpression["${escapedExpression}", InputForm, HoldComplete], $Failed];
    varHeld = Quiet @ Check[ToExpression["${escapedVariable}", InputForm, HoldComplete], $Failed];
    assumpHeld = Quiet @ Check[ToExpression["${escapedAssumptions}", InputForm, HoldComplete], $Failed];
    If[exprHeld === $Failed || varHeld === $Failed || assumpHeld === $Failed,
      "ParseError",
      FullSimplify[
        D[ReleaseHold[exprHeld], ReleaseHold[varHeld]],
        ReleaseHold[assumpHeld]
      ]
    ]
  `;
    const derivative = await executeMathematicaCode(code, format);
    return {
        normalizedExpression,
        normalizedVariable,
        normalizedAssumptions,
        derivative,
    };
}
function classifyExecutionOutput(output) {
    if (/RecursionLimit|reclim/.test(output)) {
        return {
            code: "RecursionLimit",
            summary: "Evaluation exceeded recursion depth.",
            hint: "Avoid self-referential assignments like x = x[...]. Use distinct names such as xSym = x[...].",
        };
    }
    if (/Set::wrsym|Protected/.test(output)) {
        return {
            code: "ProtectedSymbol",
            summary: "Attempted assignment to protected Mathematica symbols.",
            hint: "Rename protected symbols (for example D -> Dval, I -> Ival) before assignment.",
        };
    }
    if (/ToExpression::sntx|Syntax::|Invalid syntax/.test(output)) {
        return {
            code: "SyntaxError",
            summary: "Mathematica syntax parsing failed.",
            hint: "Use valid Mathematica syntax and avoid malformed escapes. Prefer Unicode symbols directly over LaTeX escapes.",
        };
    }
    return null;
}
/**
 * Create an MCP server with capabilities for tools to execute Mathematica code.
 */
const server = new Server({
    name: "mathematica-server",
    version: "0.1.0",
}, {
    capabilities: {
        tools: {},
    },
});
// Comprehensive logging
const log = (type, message, data) => {
    console.error(`[${type}] ${message}`, data ? data : '');
};
log('Setup', 'Initializing Mathematica MCP server...');
/**
 * Handler that lists available tools.
 * Exposes tools for executing Mathematica code and converting to LaTeX.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
    log('Tools', 'Listing available tools');
    return {
        tools: [
            {
                name: "execute_mathematica",
                description: "SOP: use after normalize_math_input; send pure symbolic Mathematica code (avoid long Print-only prose); on ErrorCode retry with targeted fixes.",
                inputSchema: {
                    type: "object",
                    properties: {
                        code: {
                            type: "string",
                            description: "Mathematica code to execute"
                        },
                        format: {
                            type: "string",
                            description: "Output format (text, latex, or mathematica)",
                            enum: ["text", "latex", "mathematica"],
                            default: "text"
                        }
                    },
                    required: ["code"]
                }
            },
            {
                name: "verify_derivation",
                description: "SOP: for derivation chains use symbolic steps; run with debugNormalizedSteps=true when debugging; keep prose as separate instruction steps.",
                inputSchema: {
                    type: "object",
                    properties: {
                        steps: {
                            type: "array",
                            description: "Array of derivation steps. Prefer Mathematica syntax; limited LaTeX forms (e.g. \\alpha, \\tau, \\kappa, \\frac{a}{b}) are normalized automatically.",
                            items: {
                                type: "string"
                            }
                        },
                        format: {
                            type: "string",
                            description: "Output format (text, latex, or mathematica)",
                            enum: ["text", "latex", "mathematica"],
                            default: "text"
                        },
                        instructionKeywords: {
                            type: "array",
                            description: "Optional custom keywords used to identify instruction-like natural language steps (supports English and Chinese)",
                            items: {
                                type: "string"
                            }
                        },
                        debugNormalizedSteps: {
                            type: "boolean",
                            description: "If true, include normalized step text in verification output for debugging",
                            default: false
                        }
                    },
                    required: ["steps"]
                }
            },
            {
                name: "normalize_math_input",
                description: "SOP first step: normalize mixed LaTeX/Unicode input before execute_mathematica or verify_derivation.",
                inputSchema: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string",
                            description: "Input text to normalize"
                        },
                        mode: {
                            type: "string",
                            description: "Normalization mode",
                            enum: ["latex", "mixed", "mathematica"],
                            default: "mixed"
                        }
                    },
                    required: ["text"]
                }
            },
            {
                name: "analyze_math_step",
                description: "SOP precheck: classify a step (instruction/equation/expression) and test parseability before chain verification.",
                inputSchema: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string",
                            description: "One step to analyze"
                        },
                        mode: {
                            type: "string",
                            description: "Analysis normalization mode",
                            enum: ["latex", "mixed", "mathematica"],
                            default: "mixed"
                        },
                        instructionKeywords: {
                            type: "array",
                            description: "Optional custom keywords used to identify instruction-like steps",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["text"]
                }
            },
            {
                name: "differentiate_symbolic",
                description: "SOP for differentiation: use normalized symbolic expression+variable; provide assumptions for FullSimplify when needed.",
                inputSchema: {
                    type: "object",
                    properties: {
                        expression: {
                            type: "string",
                            description: "Expression to differentiate"
                        },
                        variable: {
                            type: "string",
                            description: "Differentiation variable"
                        },
                        assumptions: {
                            type: "string",
                            description: "Optional Mathematica assumptions used in FullSimplify",
                            default: "True"
                        },
                        format: {
                            type: "string",
                            description: "Output format (text, latex, or mathematica)",
                            enum: ["text", "latex", "mathematica"],
                            default: "text"
                        },
                        mode: {
                            type: "string",
                            description: "Normalization mode for expression/variable/assumptions",
                            enum: ["latex", "mixed", "mathematica"],
                            default: "mixed"
                        }
                    },
                    required: ["expression", "variable"]
                }
            },
            {
                name: "list_prompt_templates",
                description: "List built-in prompt templates for math workflows",
                inputSchema: {
                    type: "object",
                    properties: {}
                }
            },
            {
                name: "get_prompt_template",
                description: "Render a built-in prompt template with provided parameters",
                inputSchema: {
                    type: "object",
                    properties: {
                        templateName: {
                            type: "string",
                            description: "Template name (for example derivation_cleanup)"
                        },
                        params: {
                            type: "object",
                            description: "Template parameters as key/value strings"
                        }
                    },
                    required: ["templateName"]
                }
            },
            {
                name: "list_reference_resources",
                description: "List built-in reference resources",
                inputSchema: {
                    type: "object",
                    properties: {}
                }
            },
            {
                name: "read_reference_resource",
                description: "Read one built-in reference resource by id",
                inputSchema: {
                    type: "object",
                    properties: {
                        resourceId: {
                            type: "string",
                            description: "Resource identifier"
                        }
                    },
                    required: ["resourceId"]
                }
            },
            {
                name: "reload_prompt_resources",
                description: "Clear prompt/resource caches and hot-reload JSON configs",
                inputSchema: {
                    type: "object",
                    properties: {}
                }
            },
            {
                name: "diagnose_mcp_capabilities",
                description: "Diagnose prompts/resources loading and cache status",
                inputSchema: {
                    type: "object",
                    properties: {}
                }
            }
        ]
    };
});
/**
 * Check if Mathematica (wolframscript) is installed and accessible
 */
async function checkMathematicaInstallation() {
    try {
        log('Setup', 'Checking Mathematica installation...');
        await execAsync('wolframscript -help');
        log('Setup', 'Mathematica installation verified');
        return true;
    }
    catch (error) {
        log('Error', 'Mathematica not found or not accessible', error);
        return false;
    }
}
/**
 * Execute Mathematica code and return the result
 * Uses temporary file approach to avoid shell escaping issues
 */
async function executeMathematicaCode(code, format = "text") {
    let formatOption = "";
    // Set the appropriate format option for wolframscript
    switch (format.toLowerCase()) {
        case "latex":
            formatOption = "-format latex";
            break;
        case "mathematica":
            formatOption = "-format mathematica";
            break;
        case "text":
        default:
            formatOption = "-format text";
            break;
    }
    // Generate a unique temporary file path
    const tempFileName = `mcp_mathematica_${Date.now()}_${Math.random().toString(36).substring(7)}.wl`;
    const tempFilePath = join(tmpdir(), tempFileName);
    try {
        log('API', 'Executing Mathematica code', { code: code.substring(0, 100) + (code.length > 100 ? '...' : '') });
        // Write code to temporary file
        await writeFile(tempFilePath, code, 'utf8');
        // Execute using the -file flag instead of -code to avoid shell escaping issues
        const { stdout, stderr } = await execAsync(`wolframscript ${formatOption} -file "${tempFilePath}"`);
        if (stderr) {
            log('Warning', 'Mathematica execution produced stderr output', stderr);
        }
        log('API', 'Mathematica execution completed successfully');
        return stdout.trim();
    }
    catch (error) {
        log('Error', 'Failed to execute Mathematica code', error);
        throw new McpError(ErrorCode.InternalError, `Failed to execute Mathematica code: ${error.message}`);
    }
    finally {
        // Clean up temporary file
        try {
            await unlink(tempFilePath);
        }
        catch (unlinkError) {
            log('Warning', 'Failed to delete temporary file', { path: tempFilePath, error: unlinkError });
        }
    }
}
/**
 * Verify a mathematical derivation by checking each step
 */
async function verifyDerivation(steps, format = "text", instructionKeywords = [], debugNormalizedSteps = false) {
    if (steps.length < 2) {
        throw new McpError(ErrorCode.InvalidParams, "At least two steps are required for a derivation");
    }
    try {
        log('API', 'Verifying mathematical derivation', { steps: steps.length });
        const analyzedSteps = await Promise.all(steps.map((step) => analyzeMathStep(step, "mixed", instructionKeywords)));
        const normalizedSteps = analyzedSteps.map((step) => step.normalizedText);
        const instructionFlags = analyzedSteps.map((step) => (step.kind === "instruction" ? "True" : "False"));
        const parseableFlags = analyzedSteps.map((step) => (step.parseable ? "True" : "False"));
        // Convert JS strings into valid Mathematica string literals and list syntax.
        const mathematicaStepsList = `{${normalizedSteps
            .map((step) => `"${step.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
            .join(", ")}}`;
        const mathematicaInstructionFlags = `{${instructionFlags.join(", ")}}`;
        const mathematicaParseableFlags = `{${parseableFlags.join(", ")}}`;
        // Create Mathematica code to verify each step
        const verificationCode = `
      normalizeDerivationStep[s_String] := Module[{t},
        t = StringTrim[s];
        t = StringReplace[t, {
          StartOfString ~~ ("Given:" | "Also given:" | "Assume:" | "Step " ~~ NumberString ~~ ":" | "We want to find" | "Find" | "Let") ~~ Whitespace... -> ""
        }];
        t = StringReplace[t, {
          "\\\\tilde{\\\\kappa}" -> "kappaTilde",
          "\\\\kappa" -> "kappa",
          "\\\\alpha" -> "alpha",
          "\\\\tau" -> "tau",
          "\\\\partial" -> "D",
          "∂" -> "D"
        }];
        t = StringReplace[t, RegularExpression["\\\\\\\\frac\\{([^{}]+)\\}\\{([^{}]+)\\}"] -> "(($1)/($2))"];
        t
      ];

      parseStep[s_String] := Module[{held, normalized},
        held = Quiet @ Check[
          ToExpression[s, InputForm, HoldComplete],
          $Failed
        ];
        If[held =!= $Failed, Return[held]];

        normalized = normalizeDerivationStep[s];
        held = Quiet @ Check[
          ToExpression[normalized, InputForm, HoldComplete],
          $Failed
        ];
        If[held =!= $Failed, Return[held]];

        (* Fallback for common UTF-8/Latin-1 mojibake on Greek symbols *)
        held = Quiet @ Check[
          ToExpression[
            FromCharacterCode[ToCharacterCode[s, "ISO8859-1"], "UTF-8"],
            InputForm,
            HoldComplete
          ],
          $Failed
        ];
        held
      ];

      steps = ${mathematicaStepsList};
      stepIsInstruction = ${mathematicaInstructionFlags};
      stepIsParseable = ${mathematicaParseableFlags};
      results = {};
      
      (* Check if each step follows from the previous *)
      For[i = 2, i <= Length[steps], i++,
        prevText = steps[[i-1]];
        currentText = steps[[i]];
        normalizedCurrentText = normalizeDerivationStep[currentText];
        prevInstruction = stepIsInstruction[[i-1]];
        currentInstruction = stepIsInstruction[[i]];
        prevParseable = stepIsParseable[[i-1]];
        currentParseable = stepIsParseable[[i]];
        
        If[prevInstruction || currentInstruction,
          AppendTo[results, {
            "step" -> i,
            "expression" -> currentText,
            "normalizedExpression" -> normalizedCurrentText,
            "equivalent" -> "SkippedInstruction",
            "note" -> "Skipped equivalence check because one of the steps is an instruction in natural language"
          }];
          Continue[];
        ];

        If[!prevParseable || !currentParseable,
          AppendTo[results, {
            "step" -> i,
            "expression" -> currentText,
            "normalizedExpression" -> normalizedCurrentText,
            "equivalent" -> "ParseError",
            "note" -> "Pre-analysis marked one of the steps as non-parseable Mathematica input"
          }];
          Continue[];
        ];
        
        prevHeld = parseStep[steps[[i-1]]];
        currentHeld = parseStep[steps[[i]]];
        
        If[prevHeld === $Failed || currentHeld === $Failed,
          AppendTo[results, {
            "step" -> i,
            "expression" -> currentText,
            "normalizedExpression" -> normalizedCurrentText,
            "equivalent" -> "ParseError",
            "note" -> "Unable to parse one of the steps as Mathematica input"
          }];
          Continue[];
        ];
        
        prev = ReleaseHold[prevHeld];
        current = ReleaseHold[currentHeld];
        
        (* Check if they're mathematically equivalent *)
        equivalent = Simplify[prev == current];
        
        (* Store the result *)
        AppendTo[results, {
          "step" -> i,
          "expression" -> currentText,
          "normalizedExpression" -> normalizedCurrentText,
          "equivalent" -> equivalent,
          "simplification" -> Simplify[current]
        }];
      ];
      
      (* Format the results *)
      FormattedResults = "Derivation Verification Results:\\n\\n";
      
      For[i = 1, i <= Length[results], i++,
        result = results[[i]];
        stepNum = "step" /. result;
        expr = "expression" /. result;
        normalizedExpr = Replace["normalizedExpression" /. result, "normalizedExpression" -> ""];
        isEquiv = "equivalent" /. result;
        note = Replace["note" /. result, "note" -> ""];
        
        FormattedResults = FormattedResults <> 
          "Step " <> ToString[stepNum] <> ": " <> expr <> "\\n" <>
          If[${debugNormalizedSteps ? "True" : "False"} && normalizedExpr =!= "", "  Normalized: " <> normalizedExpr <> "\\n", ""] <>
          "  Valid: " <> ToString[isEquiv] <> "\\n" <>
          If[note =!= "", "  Note: " <> ToString[note] <> "\\n", ""] <>
          "\\n";
      ];
      
      FormattedResults
    `;
        return await executeMathematicaCode(verificationCode, format);
    }
    catch (error) {
        log('Error', 'Failed to verify derivation', error);
        throw new McpError(ErrorCode.InternalError, `Failed to verify derivation: ${error.message}`);
    }
}
/**
 * Handler for tool execution.
 * Handles execute_mathematica and verify_derivation tools.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // First check if Mathematica is installed
    const mathematicaAvailable = await checkMathematicaInstallation();
    if (!mathematicaAvailable) {
        return {
            content: [{
                    type: "text",
                    text: "Error: Mathematica (wolframscript) is not installed or not accessible. Please make sure Mathematica is installed and wolframscript is in your PATH."
                }],
            isError: true
        };
    }
    switch (request.params.name) {
        case "execute_mathematica": {
            log('Tool', 'Executing execute_mathematica tool');
            const code = String(request.params.arguments?.code);
            const format = String(request.params.arguments?.format || "text");
            if (!code) {
                throw new McpError(ErrorCode.InvalidParams, "Mathematica code is required");
            }
            try {
                const processed = preprocessMathematicaCode(code);
                if (processed.blockedByRecursion.length > 0) {
                    return {
                        content: [{
                                type: "text",
                                text: formatToolError("PrecheckRecursiveAssignment", "Detected self-referential assignment that is likely to trigger recursion overflow.", "Rename left-hand variables to non-function names (for example rSym = r[alpha, tau]).", `Symbols: ${Array.from(new Set(processed.blockedByRecursion)).join(", ")}`)
                            }],
                        isError: true
                    };
                }
                const result = await executeMathematicaCode(processed.code, format);
                const executionIssue = classifyExecutionOutput(result);
                if (executionIssue) {
                    return {
                        content: [{
                                type: "text",
                                text: formatToolError(executionIssue.code, executionIssue.summary, executionIssue.hint, result)
                            }],
                        isError: true
                    };
                }
                const rewriteNote = processed.rewrites.length > 0
                    ? `[AutoRewrite] ${processed.rewrites.join(", ")}\n`
                    : "";
                return {
                    content: [{
                            type: "text",
                            text: `${rewriteNote}${result}`
                        }]
                };
            }
            catch (error) {
                log('Error', 'Tool execution failed', error);
                return {
                    content: [{
                            type: "text",
                            text: formatToolError("ExecutionFailed", "Failed to execute Mathematica code.", "Check Mathematica syntax and use non-protected symbol names.", error.message)
                        }],
                    isError: true
                };
            }
        }
        case "verify_derivation": {
            log('Tool', 'Executing verify_derivation tool');
            const steps = request.params.arguments?.steps;
            const format = String(request.params.arguments?.format || "text");
            const instructionKeywords = Array.isArray(request.params.arguments?.instructionKeywords)
                ? (request.params.arguments?.instructionKeywords)
                    .filter((value) => typeof value === "string")
                    .map((value) => value.trim())
                    .filter((value) => value.length > 0)
                : [];
            const debugNormalizedSteps = Boolean(request.params.arguments?.debugNormalizedSteps);
            if (!steps || !Array.isArray(steps) || steps.length < 2) {
                throw new McpError(ErrorCode.InvalidParams, "At least two derivation steps are required");
            }
            try {
                const result = await verifyDerivation(steps, format, instructionKeywords, debugNormalizedSteps);
                const executionIssue = classifyExecutionOutput(result);
                if (executionIssue) {
                    return {
                        content: [{
                                type: "text",
                                text: formatToolError(executionIssue.code, executionIssue.summary, executionIssue.hint, result)
                            }],
                        isError: true
                    };
                }
                return {
                    content: [{
                            type: "text",
                            text: result
                        }]
                };
            }
            catch (error) {
                log('Error', 'Tool execution failed', error);
                return {
                    content: [{
                            type: "text",
                            text: formatToolError("DerivationVerificationFailed", "Failed to verify derivation steps.", "Ensure each symbolic step is valid Mathematica input. For natural language steps, rely on built-in instruction detection or provide instructionKeywords.", error.message)
                        }],
                    isError: true
                };
            }
        }
        case "normalize_math_input": {
            log('Tool', 'Executing normalize_math_input tool');
            const text = String(request.params.arguments?.text || "");
            const mode = String(request.params.arguments?.mode || "mixed");
            if (!text) {
                throw new McpError(ErrorCode.InvalidParams, "Input text is required");
            }
            const normalized = normalizeMathInput(text, mode);
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify(normalized, null, 2)
                    }]
            };
        }
        case "analyze_math_step": {
            log('Tool', 'Executing analyze_math_step tool');
            const text = String(request.params.arguments?.text || "");
            const mode = String(request.params.arguments?.mode || "mixed");
            const instructionKeywords = Array.isArray(request.params.arguments?.instructionKeywords)
                ? (request.params.arguments?.instructionKeywords)
                    .filter((value) => typeof value === "string")
                    .map((value) => value.trim())
                    .filter((value) => value.length > 0)
                : [];
            if (!text) {
                throw new McpError(ErrorCode.InvalidParams, "Step text is required");
            }
            const analyzed = await analyzeMathStep(text, mode, instructionKeywords);
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify(analyzed, null, 2)
                    }]
            };
        }
        case "differentiate_symbolic": {
            log('Tool', 'Executing differentiate_symbolic tool');
            const expression = String(request.params.arguments?.expression || "");
            const variable = String(request.params.arguments?.variable || "");
            const assumptions = String(request.params.arguments?.assumptions || "True");
            const format = String(request.params.arguments?.format || "text");
            const mode = String(request.params.arguments?.mode || "mixed");
            if (!expression || !variable) {
                throw new McpError(ErrorCode.InvalidParams, "Both expression and variable are required");
            }
            try {
                const differentiated = await differentiateSymbolic(expression, variable, assumptions, format, mode);
                if (differentiated.derivative.trim() === "ParseError") {
                    return {
                        content: [{
                                type: "text",
                                text: formatToolError("DifferentiationParseError", "Failed to parse expression, variable, or assumptions for symbolic differentiation.", "Use Mathematica-compatible syntax or run normalize_math_input first.", JSON.stringify(differentiated, null, 2))
                            }],
                        isError: true
                    };
                }
                const executionIssue = classifyExecutionOutput(differentiated.derivative);
                if (executionIssue) {
                    return {
                        content: [{
                                type: "text",
                                text: formatToolError(executionIssue.code, executionIssue.summary, executionIssue.hint, differentiated.derivative)
                            }],
                        isError: true
                    };
                }
                return {
                    content: [{
                            type: "text",
                            text: differentiated.derivative
                        }]
                };
            }
            catch (error) {
                log('Error', 'Tool execution failed', error);
                return {
                    content: [{
                            type: "text",
                            text: formatToolError("SymbolicDifferentiationFailed", "Failed to differentiate expression symbolically.", "Check expression/variable syntax and assumptions.", error.message)
                        }],
                    isError: true
                };
            }
        }
        case "list_prompt_templates": {
            log('Tool', 'Executing list_prompt_templates tool');
            const templateMap = await loadPromptTemplates();
            const templates = Object.entries(templateMap).map(([name, def]) => ({
                name,
                description: def.description,
                requiredParams: def.requiredParams,
            }));
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({ templates }, null, 2)
                    }]
            };
        }
        case "get_prompt_template": {
            log('Tool', 'Executing get_prompt_template tool');
            const templateName = String(request.params.arguments?.templateName || "");
            const rawParams = request.params.arguments?.params;
            const params = {};
            if (rawParams && typeof rawParams === "object") {
                for (const [key, value] of Object.entries(rawParams)) {
                    params[key] = String(value);
                }
            }
            if (!templateName) {
                throw new McpError(ErrorCode.InvalidParams, "templateName is required");
            }
            const prompt = await renderPromptTemplate(templateName, params);
            return {
                content: [{
                        type: "text",
                        text: prompt
                    }]
            };
        }
        case "list_reference_resources": {
            log('Tool', 'Executing list_reference_resources tool');
            const resources = await loadReferenceResources();
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            resources: resources.map(({ id, title, description }) => ({ id, title, description }))
                        }, null, 2)
                    }]
            };
        }
        case "read_reference_resource": {
            log('Tool', 'Executing read_reference_resource tool');
            const resourceId = String(request.params.arguments?.resourceId || "");
            if (!resourceId) {
                throw new McpError(ErrorCode.InvalidParams, "resourceId is required");
            }
            const resources = await loadReferenceResources();
            const resource = resources.find((item) => item.id === resourceId);
            if (!resource) {
                throw new McpError(ErrorCode.InvalidParams, `Unknown resourceId: ${resourceId}`);
            }
            return {
                content: [{
                        type: "text",
                        text: resource.content
                    }]
            };
        }
        case "reload_prompt_resources": {
            log('Tool', 'Executing reload_prompt_resources tool');
            try {
                const reloaded = await reloadPromptAndResourceConfigs();
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({
                                message: "Prompt/resource configs reloaded.",
                                promptCount: reloaded.promptCount,
                                resourceCount: reloaded.resourceCount
                            }, null, 2)
                        }]
                };
            }
            catch (error) {
                return {
                    content: [{
                            type: "text",
                            text: formatToolError("ReloadPromptResourcesFailed", "Failed to reload prompt/resource configuration files.", "Check config/prompts.json and config/resources.json for valid JSON and schema.", error?.message ?? String(error))
                        }],
                    isError: true
                };
            }
        }
        case "diagnose_mcp_capabilities": {
            log('Tool', 'Executing diagnose_mcp_capabilities tool');
            const diagnostics = await diagnoseMcpCapabilities();
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify(diagnostics, null, 2)
                    }]
            };
        }
        default:
            log('Error', `Unknown tool: ${request.params.name}`);
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
});
/**
 * Start the server using stdio transport.
 * This allows the server to communicate via standard input/output streams.
 */
async function main() {
    try {
        log('Setup', 'Starting Mathematica MCP server...');
        const transport = new StdioServerTransport();
        await server.connect(transport);
        log('Setup', 'Mathematica MCP server running on stdio');
        // Set up error handling
        process.on('uncaughtException', (error) => {
            log('Error', 'Uncaught exception', error);
            process.exit(1);
        });
        process.on('unhandledRejection', (reason) => {
            log('Error', 'Unhandled rejection', reason);
        });
        process.on('SIGINT', async () => {
            log('Setup', 'Shutting down Mathematica MCP server...');
            await server.close();
            process.exit(0);
        });
    }
    catch (error) {
        log('Error', 'Failed to start server', error);
        process.exit(1);
    }
}
main().catch((error) => {
    log('Error', 'Server error', error);
    process.exit(1);
});
