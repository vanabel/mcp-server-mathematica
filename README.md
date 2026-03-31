 # Mathematica MCP Server

Language / 语言: [English](#english) | [中文](#中文)

## English

This repository contains a Model Context Protocol (MCP) server that allows MCP clients (like Cursor) to execute Mathematica code via `wolframscript` and verify mathematical derivations.

## Overview

This server acts as a bridge, enabling applications that support MCP to leverage the power of a local Mathematica installation for tasks such as:

*   Performing complex mathematical calculations.
*   Verifying mathematical derivation steps provided by humans or AI models.
*   Generating LaTeX or Mathematica string representations of expressions.

## Prerequisites

*   [Mathematica](https://www.wolfram.com/mathematica/) must be installed on your system.
*   The `wolframscript` command-line utility must be available in your system's PATH. You can test this by running `wolframscript -help` in your terminal.
*   [Node.js](https://nodejs.org/) (Recommended: v16 or later, as inferred from `tsconfig.json` target `ES2022`).

## Installation

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd <repository-directory>
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Build the server:**
    ```bash
    npm run build
    ```
    This command compiles the TypeScript source code from `src/` into JavaScript in the `build/` directory and makes the main script executable.

## Running the Server

To start the MCP server, run the following command in your terminal:

```bash
node build/index.js
```

The server will start and listen for connections from MCP clients via standard input/output (stdio). Keep this terminal window open while you intend to use the server.

For more robust deployments, consider using a process manager like `pm2` to run the server in the background and manage restarts.

## Integration with MCP Clients (e.g., Cursor, Cline, Claude Desktop)

MCP clients generally discover and communicate with running MCP servers. The exact configuration steps can vary depending on the client application.

**General Steps:**

1.  **Start the Mathematica MCP Server:** Ensure the server is running in a terminal:
    ```bash
    node build/index.js
    ```
2.  **Configure Your MCP Client:** Add the server to your client's configuration. This often involves editing a JSON settings file. See client-specific instructions below.
3.  **Restart Your MCP Client:** After starting the server or changing configuration, restart your client application to ensure it detects the Mathematica server.

**Client-Specific Configuration:**

*   **Cline:**
    According to the [Cline MCP Server Development Protocol](https://docs.cline.bot/mcp-servers/mcp-server-from-scratch), you typically configure servers in a settings file (often `settings.json` within the Cline configuration directory). You would add an entry like this:

    ```json
    {
      "mcpServers": {
        "mathematica-server": {
          "command": "node",
          "args": ["/full/path/to/mcp-server-mathematica/build/index.js"],
          "disabled": false,
          "autoApprove": [
            "execute_mathematica",
            "verify_derivation",
            "normalize_math_input",
            "analyze_math_step",
            "differentiate_symbolic",
            "list_prompt_templates",
            "get_prompt_template",
            "list_reference_resources",
            "read_reference_resource",
            "reload_prompt_resources"
          ]
        }
      }
    }
    ```
    *Replace `/full/path/to/mcp-server-mathematica/build/index.js` with the absolute path to your local `build/index.js`.*

*   **Cursor:**
    Cursor MCP settings location can vary by version and extension. Use the same server entry format shown above, and point `args` to your local `build/index.js`.

*   **Other Clients (e.g., Claude Desktop):**
    Consult the documentation for your specific MCP client. Look for sections on "MCP Servers," "Tool Configuration," or "External Tools." The configuration generally involves specifying the command (`node`), the path to the server script (`build/index.js`), and potentially environment variables if needed.

## Available Tools

The server exposes the following tools to MCP clients:

### 1. `execute_mathematica`

Executes arbitrary Mathematica code and returns the result.

**Input Schema:**

```typescript
{
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
```

**Example Usage (Client Request):**

*   **Natural Language:** "Calculate the integral of x^2 from 0 to 1 using Mathematica and format as LaTeX"
*   **Direct Tool Call:**
    ```json
    {
      "tool_name": "execute_mathematica",
      "arguments": {
        "code": "Integrate[x^2, {x, 0, 1}]",
        "format": "latex"
      }
    }
    ```

### 2. `verify_derivation`

Verifies a sequence of mathematical expressions to check if each step logically follows from the previous one using `Simplify[prev == current]`.

**Input Schema:**

```typescript
{
  type: "object",
  properties: {
    steps: {
      type: "array",
      description: "Array of mathematical expressions (as strings) representing steps in a derivation. Requires at least two steps.",
      items: {
        type: "string"
      }
    },
    format: {
      type: "string",
      description: "Output format for the verification report (text, latex, or mathematica)",
      enum: ["text", "latex", "mathematica"],
      default: "text"
    },
    instructionKeywords: {
      type: "array",
      description: "Optional custom keywords used to detect instruction-like natural language steps (English/Chinese).",
      items: {
        type: "string"
      }
    }
  },
  required: ["steps"]
}
```

`verify_derivation` can now skip natural-language instruction steps (for example, "Compute ...", "求 ...", "证明 ...") and mark them as `SkippedInstruction` instead of failing with parse errors.  
Built-in English/Chinese keywords are included, and `instructionKeywords` lets you extend this list per request.

**Example Usage (Client Request):**

*   **Natural Language:** "Verify this derivation: ['x^2 - y^2', '(x-y)(x+y)']"
*   **Direct Tool Call:**
    ```json
    {
      "tool_name": "verify_derivation",
      "arguments": {
        "steps": [
          "x^2 - y^2",
          "(x-y)*(x+y)"
        ],
        "format": "text"
      }
    }
    ```

*   **Direct Tool Call (with instruction steps + custom keywords):**
    ```json
    {
      "tool_name": "verify_derivation",
      "arguments": {
        "steps": [
          "D = Sqrt[r[α, τ]^2 + Derivative[1, 0][r][α, τ]^2]",
          "κ = (r[α, τ]^2 - r[α, τ]*Derivative[0, 1][r][α, τ])/D",
          "Compute D[κ, τ] and express in terms of κ, D, r, and their derivatives"
        ],
        "format": "latex",
        "instructionKeywords": ["differentiate", "show that", "请计算"]
      }
    }
    ```

### Recommended Input Patterns

To maximize success rate, prefer these patterns:

*   Keep symbolic steps in Mathematica-like syntax when possible (for example `kappa == (1/D^2)*(...)`).
*   Put explanatory text in separate steps (for example `Given: ...`, `We want to find ...`) so the server can mark them as `SkippedInstruction`.
*   Avoid assigning to protected symbols (`D`, `I`, `E`, `N`) in raw code.
*   Avoid self-referential assignments such as `r = r[alpha, tau]`.
*   If you mix LaTeX-like text, keep it simple (`\\alpha`, `\\tau`, `\\kappa`, `\\frac{a}{b}` are partially normalized).

Debugging normalization output:

```json
{
  "tool_name": "verify_derivation",
  "arguments": {
    "steps": [
      "Given: D\\tilde{\\kappa} = r^2 - r r_\\tau",
      "D^2 = r^2 + r_\\alpha^2",
      "We want to find \\tilde{\\kappa}_\\tau"
    ],
    "format": "text",
    "debugNormalizedSteps": true
  }
}
```

When `debugNormalizedSteps` is `true`, each reported step includes a `Normalized:` line showing the preprocessed expression that was sent to Mathematica parsing.

### 3. `normalize_math_input`

Normalizes mixed LaTeX/Mathematica text into safer Mathematica-style input before execution.

**Input Schema:**

```typescript
{
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
```

**Example Usage (Client Request):**

```json
{
  "tool_name": "normalize_math_input",
  "arguments": {
    "text": "Given: D\\tilde{\\kappa} = r^2 - r r_\\tau; D^2 = r^2 + r_\\alpha^2",
    "mode": "mixed"
  }
}
```

### 4. `analyze_math_step`

Classifies a single step as `instruction`, `equation`, `expression`, or `unknown`, and checks whether the normalized step is parseable by Mathematica.

**Input Schema:**

```typescript
{
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
```

**Example Usage (Client Request):**

```json
{
  "tool_name": "analyze_math_step",
  "arguments": {
    "text": "Given: D\\tilde{\\kappa} = r^2 - r r_\\tau",
    "mode": "mixed",
    "instructionKeywords": ["we need to find", "请计算"]
  }
}
```

### 5. `differentiate_symbolic`

Differentiates a symbolic expression with respect to one variable and simplifies the result with optional assumptions.

**Input Schema:**

```typescript
{
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
```

**Example Usage (Client Request):**

```json
{
  "tool_name": "differentiate_symbolic",
  "arguments": {
    "expression": "(1/D^2)*(-r*rAlphaAlpha + 2*rAlpha^2 + r^2)",
    "variable": "tau",
    "assumptions": "r > 0 && D > 0",
    "format": "text",
    "mode": "mixed"
  }
}
```

### 6. `list_prompt_templates`

Lists built-in prompt templates for common math workflows (for example derivation cleanup and symbolic differentiation drafting).

### 7. `get_prompt_template`

Renders one prompt template with your parameters.

**Example Usage (Client Request):**

```json
{
  "tool_name": "get_prompt_template",
  "arguments": {
    "templateName": "symbolic_differentiation",
    "params": {
      "expression": "(1/D^2)*(-r*rAlphaAlpha + 2*rAlpha^2 + r^2)",
      "variable": "tau",
      "assumptions": "r > 0 && D > 0"
    }
  }
}
```

### 8. `list_reference_resources`

Lists built-in reference resources (input guidelines, error code guide, etc.).

### 9. `read_reference_resource`

Reads a single built-in resource by id.

**Example Usage (Client Request):**

```json
{
  "tool_name": "read_reference_resource",
  "arguments": {
    "resourceId": "input-guidelines"
  }
}
```

Recommended rule resource id:

- `mcp-llm-rules` (bilingual MCP <-> LLM execution rules)

### 10. `reload_prompt_resources`

Clears in-memory prompt/resource caches and hot-reloads:

* `config/prompts.json`
* `config/resources.json`

Useful when you update JSON files without restarting the server.

**Example Usage (Client Request):**

```json
{
  "tool_name": "reload_prompt_resources",
  "arguments": {}
}
```

Recommended guard prompt template:

- `mcp_llm_rule_guard` (injects workflow constraints before generating tool payloads)
- `workflow_enforcer` (strict normalize -> execute/verify -> ErrorCode retry pipeline)

### 11. `diagnose_mcp_capabilities`

Returns diagnostics useful for client compatibility troubleshooting:

- prompt/resource config file paths
- cache load status
- prompt/resource counts and ids
- load errors (if any)
- overall status (`ok` or `degraded`)

**Example Usage (Client Request):**

```json
{
  "tool_name": "diagnose_mcp_capabilities",
  "arguments": {}
}
```

### Cherry Studio Tool-First SOP

When Prompts/Resources are not injected by the client, follow this strict order:

1. `normalize_math_input`
2. `analyze_math_step` (for each critical derivation step)
3. `verify_derivation` with `debugNormalizedSteps: true` (for derivation chains)
4. `execute_mathematica` (for pure symbolic computation; avoid long `Print`-only scripts)
5. `differentiate_symbolic` (when direct symbolic differentiation is needed)
6. On any failure, read `ErrorCode` and retry with targeted fixes

Prompt and resource definitions are now loaded from local JSON files:

* `config/prompts.json`
* `config/resources.json`

This makes templates/resources extensible without changing server code. After editing these files, restart the MCP server.

## Prompts & Resources Display Strategy

Some MCP clients may not reliably render native Prompts/Resources in all modes.  
Use a dual-path approach:

1. **Primary path (native UI):** Use the client Prompts/Resources panels if available.
2. **Fallback path (tool-based):** If native UI is missing or unresponsive, use tools directly:
   * `list_prompt_templates` -> discover prompt templates
   * `get_prompt_template` -> render a prompt with parameters
   * `list_reference_resources` -> discover resource IDs
   * `read_reference_resource` -> read resource content

Recommended operator flow:

1. Confirm server is running (`node build/index.js`).
2. Try native Prompts/Resources view in the client.
3. If not visible, call `list_prompt_templates` and `list_reference_resources`.
4. Fetch specific items via `get_prompt_template` / `read_reference_resource`.
5. Continue workflow using tools (`verify_derivation`, `differentiate_symbolic`, etc.).

## 中文

本仓库提供一个 Mathematica MCP 服务，支持在 MCP 客户端中执行 Mathematica、校验推导步骤，并提供提示模板与参考资源。

### 快速使用

1. 启动服务：
   ```bash
   node build/index.js
   ```
2. 客户端配置 `mcpServers`，`args` 指向本地 `build/index.js`。
3. 推荐 `autoApprove` 工具：
   - `execute_mathematica`
   - `verify_derivation`
   - `normalize_math_input`
   - `analyze_math_step`
   - `differentiate_symbolic`
   - `list_prompt_templates`
   - `get_prompt_template`
   - `list_reference_resources`
   - `read_reference_resource`
   - `reload_prompt_resources`

### 提示/资源如何展示

采用“双通道”：

1. 客户端原生 Prompts/Resources 面板可用时优先使用；
2. 若不显示或无响应，使用工具兜底：
   - `list_prompt_templates` / `get_prompt_template`
   - `list_reference_resources` / `read_reference_resource`

### 配置改为 JSON 可扩展

提示与资源内容已从硬编码改为本地文件加载：

- `config/prompts.json`
- `config/resources.json`

修改后可调用 `reload_prompt_resources` 热重载，无需重启服务。

## 官方 Wolfram MCP 方案（可选）

你也可以使用官方 Wolfram MCP paclet：

- [Wolfram/MCPServer (Paclet Repository)](https://resources.wolframcloud.com/PacletRepository/resources/Wolfram/MCPServer/)

选型建议：

- 需要自定义流程控制、Tool-first SOP、Cherry 兼容兜底时，优先本项目（Node MCP）。
- 需要更原生的 Wolfram 管理体验与生态集成时，评估官方 Wolfram MCP。

推荐并行迁移/验证清单：

1. 保留当前 Node MCP 作为基线。
2. 在同一客户端安装并配置 Wolfram MCP。
3. 对比两者：
   - tools 可发现性
   - prompts/resources 表现
   - 目标任务（如符号推导）稳定性
4. 选择表现更好的作为默认，另一套作为备用。

官方 MCP 配置示例（stdio）：

```json
{
  "mcpServers": {
    "Wolfram": {
      "isActive": true,
      "name": "Wolfram",
      "type": "stdio",
      "description": "",
      "baseUrl": "",
      "command": "/Applications/Wolfram.app/Contents/MacOS/wolfram",
      "args": [
        "-run",
        "PacletSymbol[\"Wolfram/MCPServer\",\"Wolfram`MCPServer`StartMCPServer\"][]",
        "-noinit",
        "-noprompt"
      ],
      "env": {
        "MCP_SERVER_NAME": "Wolfram"
      },
      "longRunning": true,
      "installSource": "unknown"
    }
  }
}
```

如何通过 Wolfram 工具生成这段配置：

1. 在终端执行：

```mma
wolframscript
PacletInstall["Wolfram/MCPServer"]
Needs["Wolfram`MCPServer`"]
InstallMCPServer["ClaudeDesktop"]
```

2. 安装过程中可能下载 LLMKit（体积较大，约 572 MB）。
3. 成功后，Wolfram 输出会显示目标配置文件路径，例如：
   - `Location -> File[/Users/vanabel/Library/Application Support/Claude/claude_desktop_config.json]`
4. 打开该 JSON 文件，复制 Wolfram MCP 片段，并按你的客户端 MCP 格式调整。

## 故障排查

*   **服务未发现/无响应：**
    *   确认服务已在终端启动（`node build/index.js`）。
    *   检查 `wolframscript` 是否可用并在 PATH 中（`wolframscript -help`）。
    *   重启 MCP 客户端。
    *   检查客户端 MCP 配置是否正确。
*   **工具报错：**
    *   查看服务终端 stderr 日志与 `wolframscript` 错误信息。
    *   检查传入的 Mathematica `code` 或 `steps` 语法。
    *   确保 `verify_derivation` 的 `steps` 至少有两个元素。
*   **Mathematica 本体问题：** 确保 Mathematica 安装可用且许可正常。

## 结构化错误码（Structured Error Codes）

工具错误会按结构化纯文本返回，便于客户端解析：

```text
ErrorCode: <code>
Summary: <human-readable summary>
Hint: <actionable fix guidance>
Details: <raw execution details when available>
```

常见 `ErrorCode`：

*   `PrecheckRecursiveAssignment`：执行前检测到自引用赋值（如 `r = r[alpha, tau]`）。  
    **修复：** 使用不同变量名（如 `rSym = r[alpha, tau]`）。
*   `RecursionLimit`：求值时递归深度超限。  
    **修复：** 移除循环定义，避免递归式符号赋值。
*   `ProtectedSymbol`：对受保护符号（如 `D`、`I`、`E`、`N`）赋值。  
    **修复：** 改名（如 `Dval`、`Ival`）；服务会尝试自动改写常见场景。
*   `SyntaxError`：Mathematica 语法解析失败。  
    **修复：** 使用合法 Mathematica 语法并清理转义；优先用正常 Unicode 符号。
*   `ExecutionFailed`：`execute_mathematica` 通用执行失败。  
    **修复：** 查看 `Details` 后按提示调整代码。
*   `DerivationVerificationFailed`：`verify_derivation` 通用验证失败。  
    **修复：** 确保步骤可被 Mathematica 解析；自然语言步骤可用内置识别或 `instructionKeywords`。

Node.js 解析示例：

```js
function parseStructuredToolError(text) {
  const result = {
    errorCode: null,
    summary: null,
    hint: null,
    details: null,
    raw: text
  };

  if (typeof text !== "string") return result;

  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("ErrorCode: ")) result.errorCode = line.slice("ErrorCode: ".length).trim();
    else if (line.startsWith("Summary: ")) result.summary = line.slice("Summary: ".length).trim();
    else if (line.startsWith("Hint: ")) result.hint = line.slice("Hint: ".length).trim();
    else if (line.startsWith("Details: ")) result.details = line.slice("Details: ".length).trim();
  }

  return result;
}
```

客户端错误处理策略示例：

```js
function getRetryAdvice(parsedError) {
  switch (parsedError.errorCode) {
    case "ProtectedSymbol":
      return {
        userMessage: "检测到受保护符号赋值，建议将 D/I/E/N 改名后重试。",
        shouldRetry: true
      };
    case "PrecheckRecursiveAssignment":
    case "RecursionLimit":
      return {
        userMessage: "检测到递归定义风险，请改成非自引用变量（如 rSym = r[alpha, tau]）。",
        shouldRetry: false
      };
    case "SyntaxError":
      return {
        userMessage: "输入语法无效，请检查 Mathematica 语法或转义字符。",
        shouldRetry: false
      };
    default:
      return {
        userMessage: "执行失败，请查看详细错误信息后重试。",
        shouldRetry: false
      };
  }
}
```

End-to-end example (request -> parse -> strategy -> optional retry):

```js
async function callVerifyDerivation(mcpClient, args) {
  return mcpClient.callTool({
    name: "verify_derivation",
    arguments: args
  });
}

async function verifyWithOneRetry(mcpClient, initialArgs) {
  let response = await callVerifyDerivation(mcpClient, initialArgs);
  let text = response?.content?.[0]?.text ?? "";

  // If tool reported a structured error, parse and decide next action.
  if (response?.isError) {
    const parsed = parseStructuredToolError(text);
    const advice = getRetryAdvice(parsed);
    console.log("First attempt failed:", advice.userMessage);

    if (!advice.shouldRetry) {
      return { ok: false, response, parsed, retried: false };
    }

    // Example retry patch: add custom instruction keywords to skip natural language steps.
    const retryArgs = {
      ...initialArgs,
      instructionKeywords: [
        ...(initialArgs.instructionKeywords || []),
        "please compute",
        "show that",
        "请计算",
        "请证明"
      ]
    };

    response = await callVerifyDerivation(mcpClient, retryArgs);
    text = response?.content?.[0]?.text ?? "";

    if (response?.isError) {
      return {
        ok: false,
        response,
        parsed: parseStructuredToolError(text),
        retried: true
      };
    }
    return { ok: true, response, retried: true };
  }

  return { ok: true, response, retried: false };
}
```

## Project Structure

*   `src/`: TypeScript source code for the server.
*   `build/`: Compiled JavaScript output (generated by `npm run build`).
*   `package.json`: Project metadata and dependencies.
*   `tsconfig.json`: TypeScript compiler configuration.
