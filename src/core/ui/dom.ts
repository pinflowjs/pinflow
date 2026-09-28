import { STYLES } from './styles';
import { createRoot, resolveStyleStrategy, type StyleStrategy, type UIRoot } from './dom-base';
export * from './dom-base';
export function createUIRoot(strategy: StyleStrategy = resolveStyleStrategy()): UIRoot {
  return createRoot(STYLES, strategy);
}
