// Minimal Chrome MV3 typings for the subset of APIs AuthForge uses.
// Kept intentionally narrow — no @types/chrome dependency.

declare namespace chrome {
  namespace storage {
    interface StorageArea {
      get(keys: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      clear(): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
  }

  namespace runtime {
    interface MessageSender {
      tab?: { id?: number; url?: string };
    }
    const lastError: { message?: string } | undefined;
    function sendMessage(message: unknown): Promise<unknown>;
    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void
        ) => boolean | void
      ): void;
    };
    function getURL(path: string): string;
  }

  namespace tabs {
    interface Tab {
      id?: number;
    }
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
  }

  namespace alarms {
    interface Alarm {
      name: string;
    }
    function create(
      name: string,
      alarmInfo: { when?: number; delayInMinutes?: number; periodInMinutes?: number }
    ): void;
    function clear(name: string): Promise<boolean>;
    const onAlarm: { addListener(callback: (alarm: Alarm) => void): void };
  }

  namespace commands {
    const onCommand: { addListener(callback: (command: string) => void): void };
  }

  namespace offscreen {
    function hasDocument(): Promise<boolean>;
    function createDocument(doc: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
    function closeDocument(): Promise<void>;
  }

  namespace action {
    function setBadgeText(details: { text: string; tabId?: number }): void;
    function setBadgeBackgroundColor(details: { color: string }): void;
  }
}
