import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type SecretSpec = { name: string; required: boolean; description: string };
export type ErrorSpec = { code: string; message: string; actionable_advice: string };
export type ToolTest = {
  id: string;
  name: string;
  source: "ts" | "json";
  payload: string;
  expectStatus: number;
};

export type ToolConfig = {
  name: string;
  description: string;
  version: string;
  tool_dependencies: string[];
  network_requests: string[];
  rate_limit_rpm: number;
  secrets: SecretSpec[];
  errors: ErrorSpec[];
};

export type ChatMessage = { id: string; role: "assistant" | "user"; text: string };

const DEFAULT_LOGIC = `import type { ToolExecutionContext } from "/core/contracts";

export default async function execute(
  request: Request,
  context: ToolExecutionContext,
): Promise<Response> {
  const payload = await request.json();

  if (!payload.city) {
    return Response.json(
      { error: { code: "MISSING_CITY", message: "city is required" } },
      { status: 400 },
    );
  }

  // Never call global fetch() directly — go through the gateway.
  const res = await context.gateway.fetch(
    \`https://api.external.com/weather?q=\${payload.city}\`,
    { headers: { authorization: \`Bearer \${context.secrets.EXTERNAL_API_KEY}\` } },
  );

  return Response.json({ success: true, data: await res.json() });
}
`;

type Store = {
  toolName: string;
  setToolName: (v: string) => void;
  logic: string;
  setLogic: (v: string) => void;
  config: ToolConfig;
  setConfig: (patch: Partial<ToolConfig>) => void;
  secretValues: Record<string, string>;
  setSecretValue: (k: string, v: string) => void;
  mergeEnv: (env: Record<string, string>) => number;
  tests: ToolTest[];
  results: Record<string, { status: number; ms: number }>;
  runTests: () => void;
  chat: ChatMessage[];
  sendChat: (text: string) => void;
  dirty: boolean;
  markSaved: () => void;
  files: { name: string; language: string; content: string }[];
};

const ToolContext = createContext<Store | null>(null);

const uid = () => Math.random().toString(36).slice(2, 9);

export function ToolProvider({ children }: { children: ReactNode }) {
  const [toolName, setToolNameRaw] = useState("weather_fetcher");
  const [logic, setLogicRaw] = useState(DEFAULT_LOGIC);
  const [dirty, setDirty] = useState(false);
  const [config, setConfigRaw] = useState<ToolConfig>({
    name: "weather_fetcher",
    description: "Fetches current weather for a city through the network gateway.",
    version: "1.0.0",
    tool_dependencies: ["network_gateway"],
    network_requests: ["https://api.external.com"],
    rate_limit_rpm: 300,
    secrets: [
      {
        name: "EXTERNAL_API_KEY",
        required: true,
        description: "API key for api.external.com",
      },
      { name: "TRACE_ENDPOINT", required: false, description: "Optional trace collector" },
    ],
    errors: [
      {
        code: "MISSING_CITY",
        message: "city is required",
        actionable_advice: "Include a non-empty `city` string in the request payload.",
      },
      {
        code: "UPSTREAM_TIMEOUT",
        message: "weather provider did not respond",
        actionable_advice: "Retry once after 2s, then report the outage to the caller.",
      },
    ],
  });
  const [secretValues, setSecretValues] = useState<Record<string, string>>({
    EXTERNAL_API_KEY: "",
    TRACE_ENDPOINT: "",
  });
  const [tests] = useState<ToolTest[]>([
    {
      id: "t1",
      name: "Happy path — known city",
      source: "ts",
      payload: '{ "city": "Lisbon" }',
      expectStatus: 200,
    },
    {
      id: "t2",
      name: "Missing city returns actionable error",
      source: "ts",
      payload: "{}",
      expectStatus: 400,
    },
    {
      id: "t3",
      name: "Divide by zero error",
      source: "json",
      payload: '{ "city": "", "units": "c" }',
      expectStatus: 400,
    },
    {
      id: "t4",
      name: "Unknown field is ignored",
      source: "json",
      payload: '{ "city": "Oslo", "nope": 1 }',
      expectStatus: 200,
    },
  ]);
  const [results, setResults] = useState<Record<string, { status: number; ms: number }>>({});
  const [chat, setChat] = useState<ChatMessage[]>([
    {
      id: uid(),
      role: "assistant",
      text: "I am ready to help you build this tool. I can read the active tab, propose edits, and run the validators.",
    },
  ]);

  const setToolName = useCallback((v: string) => {
    setToolNameRaw(v);
    setDirty(true);
  }, []);
  const setLogic = useCallback((v: string) => {
    setLogicRaw(v);
    setDirty(true);
  }, []);
  const setConfig = useCallback((patch: Partial<ToolConfig>) => {
    setConfigRaw((c) => ({ ...c, ...patch }));
    setDirty(true);
  }, []);
  const setSecretValue = useCallback((k: string, v: string) => {
    setSecretValues((s) => ({ ...s, [k]: v }));
    setDirty(true);
  }, []);

  const mergeEnv = useCallback((env: Record<string, string>) => {
    let filled = 0;
    setSecretValues((s) => {
      const next = { ...s };
      for (const [k, v] of Object.entries(env)) {
        if (!next[k]) {
          next[k] = v;
          filled += 1;
        }
      }
      return next;
    });
    return filled;
  }, []);

  const runTests = useCallback(() => {
    setResults(
      Object.fromEntries(
        tests.map((t) => [
          t.id,
          {
            status: t.id === "t3" ? 500 : t.expectStatus,
            ms: 40 + Math.round(Math.random() * 180),
          },
        ]),
      ),
    );
  }, [tests]);

  const sendChat = useCallback((text: string) => {
    setChat((c) => [
      ...c,
      { id: uid(), role: "user", text },
      {
        id: uid(),
        role: "assistant",
        text: "Noted. I'll keep the config block and the execution logic in sync while you work on that.",
      },
    ]);
  }, []);

  const files = useMemo(() => {
    const configBlock = `export const config = ${JSON.stringify(
      {
        name: config.name,
        description: config.description,
        version: config.version,
        tool_dependencies: config.tool_dependencies,
        network_requests: config.network_requests,
        rate_limit_rpm: config.rate_limit_rpm,
        secrets: Object.fromEntries(
          config.secrets.map((s) => [s.name, { required: s.required, description: s.description }]),
        ),
        errors: config.errors,
        tests: tests
          .filter((t) => t.source === "ts")
          .map((t) => ({ name: t.name, payload: t.payload, expect: { status: t.expectStatus } })),
      },
      null,
      2,
    )} as const;`;

    return [
      {
        name: `${toolName}.ts`,
        language: "typescript",
        content: `// Combined execution logic and config\n${configBlock}\n\n${logic}`,
      },
      {
        name: `${toolName}.json`,
        language: "json",
        content: JSON.stringify(
          {
            name: config.name,
            description: config.description,
            version: config.version,
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
          null,
          2,
        ),
      },
      {
        name: `${toolName}.env`,
        language: "env",
        content: config.secrets
          .map((s) => `${s.name}=${secretValues[s.name] ? "********" : ""}`)
          .join("\n"),
      },
      {
        name: `${toolName}_tests.json`,
        language: "json",
        content: JSON.stringify(
          tests
            .filter((t) => t.source === "json")
            .map((t) => ({ name: t.name, payload: t.payload, expect: { status: t.expectStatus } })),
          null,
          2,
        ),
      },
    ];
  }, [toolName, logic, config, secretValues, tests]);

  const value: Store = {
    toolName,
    setToolName,
    logic,
    setLogic,
    config,
    setConfig,
    secretValues,
    setSecretValue,
    mergeEnv,
    tests,
    results,
    runTests,
    chat,
    sendChat,
    dirty,
    markSaved: () => setDirty(false),
    files,
  };

  return <ToolContext.Provider value={value}>{children}</ToolContext.Provider>;
}

export function useTool() {
  const ctx = useContext(ToolContext);
  if (!ctx) throw new Error("useTool must be used inside ToolProvider");
  return ctx;
}
