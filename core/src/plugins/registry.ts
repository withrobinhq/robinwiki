type HookFn = (...args: any[]) => Promise<void>;

// Filters RobinPlugin down to only function fields (excludes 'name' and any future non-function fields)
// This ensures runHook only accepts valid hook names, not arbitrary plugin properties
type PluginHooks = {
  [K in keyof RobinPlugin as RobinPlugin[K] extends HookFn | undefined ? K : never]: RobinPlugin[K];
};

export interface RobinPlugin {
  name: string;
  // Hooks will be added as we go.
  // For now, we define the structure to accept potential overrides
  onSessionCreate?: (session: any) => Promise<void>;
}

const plugins: RobinPlugin[] = [];

export function registerPlugin(plugin: RobinPlugin) {
  plugins.push(plugin);
}

export async function runHook<K extends keyof PluginHooks>(
  hookName: K,
  // Args are inferred from the specific hook's signature, so this stays type-safe as hooks are added
  ...args: Parameters<Exclude<PluginHooks[K], undefined>>
): Promise<void> {
  for (const plugin of plugins) {
    const hook = plugin[hookName] as HookFn | undefined;
    if (typeof hook === 'function') {
      await hook(...args);
    }
  }
}
