"use strict";

const { HttpStatus } = require("@nestjs/common");

function routeKey(route) {
  return `${route.method} ${route.path}`;
}

function statusValue(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) return Number(value);
    const status = HttpStatus[value.split(".").at(-1)];
    if (typeof status === "number") return status;
  }
  return null;
}

function currentStatus(route) {
  const explicit = route.explicitStatus?.[0];
  if (explicit != null) return statusValue(explicit);
  return statusValue(route.frameworkDefaultStatusCandidate);
}

function requestDecoratorShape(route) {
  return (route.requestDecorators ?? route.requestInputs ?? [])
    .map((input) => ({ name: input.name, args: input.args ?? [] }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function guardShape(route) {
  return {
    controller: [...(route.controllerGuards ?? [])].sort(),
    method: [...(route.methodGuards ?? [])].sort(),
  };
}

function compareHttpContracts(baselineRoutes, currentRoutes) {
  const errors = [];
  const baselineByKey = new Map();
  const currentByKey = new Map();

  for (const route of baselineRoutes) {
    const key = routeKey(route);
    if (baselineByKey.has(key)) errors.push({ kind: "duplicate-baseline-route", route: key });
    baselineByKey.set(key, route);
  }
  for (const route of currentRoutes) {
    const key = routeKey(route);
    if (currentByKey.has(key)) errors.push({ kind: "duplicate-current-route", route: key });
    currentByKey.set(key, route);
  }

  for (const [key, baseline] of baselineByKey) {
    const current = currentByKey.get(key);
    if (!current) {
      errors.push({ kind: "removed-route", route: key });
      continue;
    }

    const actualStatus = currentStatus(current);
    if (actualStatus == null || actualStatus !== baseline.status) {
      errors.push({ kind: "status-changed", route: key, before: baseline.status, after: actualStatus });
    }

    const expectedInputs = requestDecoratorShape(baseline);
    const actualInputs = requestDecoratorShape(current);
    if (JSON.stringify(expectedInputs) !== JSON.stringify(actualInputs)) {
      errors.push({ kind: "request-decorators-changed", route: key, before: expectedInputs, after: actualInputs });
    }

    const expectedGuards = guardShape(baseline);
    const actualGuards = guardShape(current);
    if (JSON.stringify(expectedGuards) !== JSON.stringify(actualGuards)) {
      errors.push({ kind: "guards-changed", route: key, before: expectedGuards, after: actualGuards });
    }
  }

  const additions = [...currentByKey.keys()].filter((key) => !baselineByKey.has(key)).sort();
  return { errors, additions, baselineRouteCount: baselineByKey.size, currentRouteCount: currentByKey.size };
}

module.exports = { compareHttpContracts, currentStatus, statusValue };
