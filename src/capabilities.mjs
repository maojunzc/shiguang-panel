const MAX_ROUTES = 10000;
const ROUTE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/;

export function normalizeCapabilityManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('清单格式无效');
  }
  if (value.service !== 'shiguang-game' || value.schemaVersion !== 1) {
    throw new Error('不是兼容服务端的协议清单');
  }
  if (!Number.isInteger(value.serverId) || value.serverId < 1 || value.serverId > 2147483647) {
    throw new Error('清单中的区服 ID 无效');
  }
  if (!Array.isArray(value.routes) || value.routes.length > MAX_ROUTES) {
    throw new Error('清单路由数量无效');
  }
  const routes = [...new Set(value.routes)];
  if (routes.length !== value.routes.length || routes.some(
    (route) => typeof route !== 'string' || !ROUTE_PATTERN.test(route),
  )) {
    throw new Error('清单含重复或无效路由');
  }
  if (value.routeCount !== routes.length) {
    throw new Error('清单路由数量与内容不一致');
  }
  return {
    service: value.service,
    schemaVersion: value.schemaVersion,
    serverId: value.serverId,
    routeCount: routes.length,
    routes,
  };
}
