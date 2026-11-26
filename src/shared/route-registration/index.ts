export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteDefinition {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operationId?: string;
}

export interface RouteModule {
  readonly name: string;
  readonly routes: readonly RouteDefinition[];
}

export interface RegisteredRoute extends RouteDefinition {
  readonly moduleName: string;
}

export function registerRouteModules(
  modules: readonly RouteModule[],
): readonly RegisteredRoute[] {
  const moduleNames = new Set<string>();
  const routeKeys = new Set<string>();
  const operationIds = new Set<string>();
  const registered: RegisteredRoute[] = [];

  for (const module of modules) {
    if (!module.name.trim() || moduleNames.has(module.name)) {
      throw new Error(
        `Route module name is empty or duplicated: ${module.name}`,
      );
    }
    moduleNames.add(module.name);
    for (const route of module.routes) {
      if (!route.path.startsWith("/") || route.path.includes("//")) {
        throw new Error(
          `Route path must be absolute and normalized: ${route.path}`,
        );
      }
      const key = `${route.method} ${normalizePath(route.path)}`;
      if (routeKeys.has(key)) throw new Error(`Duplicate route: ${key}`);
      routeKeys.add(key);
      if (route.operationId) {
        if (operationIds.has(route.operationId)) {
          throw new Error(`Duplicate operation ID: ${route.operationId}`);
        }
        operationIds.add(route.operationId);
      }
      registered.push(Object.freeze({ ...route, moduleName: module.name }));
    }
  }
  return Object.freeze(registered);
}

function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}
