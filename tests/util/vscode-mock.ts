/**
 * Minimal `vscode` API mock for unit tests. Tests do:
 *
 *     vi.mock("vscode", async () =>
 *       (await import("../util/vscode-mock")).makeVscodeMock(),
 *     );
 *
 * Per-test state lives in fakes the test itself constructs (e.g. an in-memory
 * SecretStorage map). The mock surface here only covers what's needed across
 * `src/tenants/*` and `src/views/*` unit tests.
 */
import { vi } from "vitest";

export class MockEventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }

  dispose(): void {
    this.listeners = [];
  }
}

/** Plain TreeItem stand-in — just the shape our node classes set. */
export class MockTreeItem {
  label: string | undefined;
  collapsibleState: number | undefined;
  description?: string;
  tooltip?: string | { value: string };
  contextValue?: string;
  iconPath?: unknown;
  command?: unknown;
  constructor(label: string | undefined, state?: number) {
    this.label = label;
    this.collapsibleState = state;
  }
}

export class MockThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: MockThemeColor,
  ) {}
}

export class MockThemeColor {
  constructor(public readonly id: string) {}
}

export class MockMarkdownString {
  isTrusted: boolean;
  supportThemeIcons: boolean;
  constructor(
    public value = "",
    supportThemeIcons = false,
  ) {
    this.isTrusted = false;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendText(value: string): this {
    this.value += value;
    return this;
  }
  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }
  appendCodeblock(value: string, lang?: string): this {
    this.value += `\n\`\`\`${lang ?? ""}\n${value}\n\`\`\`\n`;
    return this;
  }
}

/** Mock for `vscode.Uri` — covers the parsing / joining / stringifying that
 * the FileSystemProvider, inspector panel, and tree nodes exercise. */
export class MockUri {
  constructor(
    public readonly path: string,
    public readonly scheme: string = "file",
    public readonly authority: string = "",
  ) {}
  static parse(s: string): MockUri {
    const m = /^([^:]+):\/\/([^/?#]*)(\/[^?#]*)?/.exec(s);
    if (!m) return new MockUri(s);
    return new MockUri(m[3] ?? "", m[1], m[2] ?? "");
  }
  static joinPath(base: MockUri, ...segments: string[]): MockUri {
    const sep = base.path.endsWith("/") ? "" : "/";
    return new MockUri([base.path, segments.join("/")].join(sep), base.scheme, base.authority);
  }
  static file(p: string): MockUri {
    return new MockUri(p, "file", "");
  }
  toString(): string {
    if (!this.scheme) return this.path;
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

/** Mock for `vscode.FileSystemError`. Mirrors the static-factory shape; tests
 * assert on `.code` or `instanceof MockFileSystemError`. */
export class MockFileSystemError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "FileNotFound"
      | "FileExists"
      | "NoPermissions"
      | "FileNotADirectory"
      | "FileIsADirectory"
      | "Unavailable",
  ) {
    super(message);
    this.name = "FileSystemError";
  }
}
export const MockFileSystemErrorFactory = {
  NoPermissions: (u: unknown) =>
    new MockFileSystemError(`NoPermissions: ${String(u)}`, "NoPermissions"),
  FileNotFound: (u: unknown) =>
    new MockFileSystemError(`FileNotFound: ${String(u)}`, "FileNotFound"),
  Unavailable: (u: unknown) => new MockFileSystemError(`Unavailable: ${String(u)}`, "Unavailable"),
};

/** Minimal `WebviewPanel`/`Webview` stand-in. Records `postMessage` calls and
 * exposes a hook for the test to simulate `onDidReceiveMessage`. */
export interface MockWebview {
  html: string;
  cspSource: string;
  asWebviewUri: (uri: MockUri) => MockUri;
  postMessage: ReturnType<typeof vi.fn>;
  onDidReceiveMessage: (handler: (msg: unknown) => unknown) => { dispose(): void };
  /** Test helper — invoke the registered handler. */
  __fireReceive(msg: unknown): void;
}

export interface MockWebviewPanel {
  webview: MockWebview;
  iconPath?: unknown;
  reveal: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  onDidDispose: (handler: () => void) => { dispose(): void };
  __fireDispose(): void;
}

export function makeMockWebviewPanel(): MockWebviewPanel {
  let receiveHandler: ((msg: unknown) => unknown) | null = null;
  let disposeHandler: (() => void) | null = null;
  const webview: MockWebview = {
    html: "",
    cspSource: "vscode-mock-cspsrc",
    asWebviewUri: (u) => u,
    postMessage: vi.fn(() => Promise.resolve(true)),
    onDidReceiveMessage: (handler) => {
      receiveHandler = handler;
      return { dispose: () => undefined };
    },
    __fireReceive(msg) {
      receiveHandler?.(msg);
    },
  };
  const panel: MockWebviewPanel = {
    webview,
    reveal: vi.fn(),
    dispose: vi.fn(() => {
      disposeHandler?.();
    }),
    onDidDispose: (handler) => {
      disposeHandler = handler;
      return { dispose: () => undefined };
    },
    __fireDispose() {
      disposeHandler?.();
    },
  };
  return panel;
}

export function makeVscodeMock(): Record<string, unknown> {
  const createdPanels: MockWebviewPanel[] = [];
  const createWebviewPanel = vi.fn(() => {
    const p = makeMockWebviewPanel();
    createdPanels.push(p);
    return p;
  });
  const treeViewRevealCalls: Array<{ element: unknown; options: unknown }> = [];
  const createTreeView = vi.fn(() => ({
    onDidChangeSelection: vi.fn(() => ({ dispose: () => undefined })),
    onDidChangeVisibility: vi.fn(() => ({ dispose: () => undefined })),
    reveal: vi.fn((element: unknown, options: unknown) => {
      treeViewRevealCalls.push({ element, options });
      return Promise.resolve();
    }),
    dispose: vi.fn(),
    selection: [],
    visible: true,
  }));
  return {
    EventEmitter: MockEventEmitter,
    TreeItem: MockTreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: MockThemeIcon,
    ThemeColor: MockThemeColor,
    MarkdownString: MockMarkdownString,
    Uri: MockUri,
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    Disposable: {
      from: (..._: Array<{ dispose(): unknown }>) => ({ dispose: () => undefined }),
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: vi.fn(() => ({
        get: vi.fn(),
        update: vi.fn(),
      })),
      registerFileSystemProvider: vi.fn(() => ({ dispose: () => undefined })),
      fs: {
        writeFile: vi.fn(() => Promise.resolve()),
        readFile: vi.fn(() => Promise.resolve(new Uint8Array())),
      },
    },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    FilePermission: { Readonly: 1 },
    FileSystemError: MockFileSystemErrorFactory,
    window: {
      createWebviewPanel,
      createTreeView,
      registerTreeDataProvider: vi.fn(() => ({ dispose: () => undefined })),
      createOutputChannel: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        append: vi.fn(),
        appendLine: vi.fn(),
        dispose: vi.fn(),
      })),
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showInputBox: vi.fn(),
      showSaveDialog: vi.fn(),
      showOpenDialog: vi.fn(),
      withProgress: vi.fn((_opts: unknown, task: (p: unknown, t: unknown) => unknown) =>
        task({ report: () => undefined }, {}),
      ),
    },
    commands: {
      registerCommand: vi.fn(() => ({ dispose: () => undefined })),
      executeCommand: vi.fn(() => Promise.resolve(undefined)),
    },
    /** Test helpers — not part of the real API. */
    __mockState: {
      createdPanels,
      createWebviewPanel,
      createTreeView,
    },
  };
}
