#!/usr/bin/env bash
# Read-only AST audit for third-party owners of Terrific-controlled Pi UI surfaces.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS_PATH="${AUDIT_UI_OWNERS_SETTINGS:-$AGENT_DIR/settings.json}"
TYPESCRIPT="$ROOT/extensions/appearance/node_modules/typescript/lib/typescript.js"
[[ -f "$TYPESCRIPT" ]] || { echo "third-party UI owner audit failed closed: missing repository-local TypeScript compiler: $TYPESCRIPT" >&2; exit 1; }

node - "$AGENT_DIR" "$TYPESCRIPT" "${AUDIT_UI_OWNERS_SELF_TEST_ONLY:-0}" "$SETTINGS_PATH" <<'JS'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const [agentDir, typescriptPath, selfTestFlag, settingsPath] = process.argv.slice(2);
const ts = require(typescriptPath);
const selfTestOnly = selfTestFlag === "1";
const sourceSuffixes = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const setters = new Set(["setHeader", "setEditorComponent", "setFooter"]);
const componentTargets = new Set(["UserMessageComponent", "ToolExecutionComponent"]);
const piPackage = "@earendil-works/pi-coding-agent";
const contextTypes = new Set(["ExtensionContext", "ExtensionCommandContext"]);
const uiTypes = new Set(["ExtensionUIContext"]);
const apiTypes = new Set(["ExtensionAPI"]);
const nonproductionParts = new Set(["test", "tests", "example", "examples", "fixture", "fixtures", "benchmark", "benchmarks"]);

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression?.(node) || ts.isPartiallyEmittedExpression(node))) {
    node = node.expression;
  }
  return node;
}

function propertyName(node) {
  node = unwrap(node);
  if (!node) return undefined;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const argument = unwrap(node.argumentExpression);
    if (ts.isStringLiteralLike(argument)) return argument.text;
  }
  return undefined;
}

function propertyBase(node) {
  node = unwrap(node);
  if (!node) return undefined;
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? unwrap(node.expression) : undefined;
}

function sourceHasOwner(source, fileName = "fixture.ts") {
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  if (tree.parseDiagnostics.length) throw new Error(`unable to parse third-party source ${fileName}: ${tree.parseDiagnostics[0].messageText}`);
  const nodes = [];
  function collect(node) {
    nodes.push(node);
    ts.forEachChild(node, collect);
  }
  collect(tree);

  const scopes = new Map();
  const declarationKeys = new WeakMap();
  function isScope(node) {
    return ts.isSourceFile(node) || ts.isFunctionLike(node) || ts.isBlock(node) || ts.isCatchClause(node);
  }
  function containingScope(node) {
    let current = node;
    while (current && !isScope(current)) current = current.parent;
    return current;
  }
  function declare(name, scope) {
    if (!name || !ts.isIdentifier(name) || !scope) return;
    let bindings = scopes.get(scope);
    if (!bindings) scopes.set(scope, bindings = new Map());
    let key = bindings.get(name.text);
    if (!key) bindings.set(name.text, key = {});
    declarationKeys.set(name, key);
  }
  function declarePattern(name, scope) {
    if (ts.isIdentifier(name)) declare(name, scope);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) declarePattern(element.name, scope);
      }
    }
  }
  for (const node of nodes) {
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node)) declare(node.name, tree);
    else if (ts.isParameter(node)) declarePattern(node.name, containingScope(node.parent));
    else if (ts.isVariableDeclaration(node)) declarePattern(node.name, containingScope(node.parent));
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) declare(node.name, containingScope(node.parent));
    else if (ts.isFunctionExpression(node) && node.name) declare(node.name, node);
  }
  function bindingKey(node) {
    node = unwrap(node);
    if (!node || !ts.isIdentifier(node)) return undefined;
    const declared = declarationKeys.get(node);
    if (declared) return declared;
    let current = node.parent;
    while (current) {
      if (isScope(current)) {
        const key = scopes.get(current)?.get(node.text);
        if (key) return key;
      }
      current = current.parent;
    }
    return undefined;
  }

  const apiAliases = new Set();
  const contextAliases = new Set();
  const uiAliases = new Set();
  const setterAliases = new Set();
  const componentAliases = new Set();
  const prototypeAliases = new Set();
  const definePropertyAliases = new Set();
  const namespaceAliases = new Set();
  const importedContextTypes = new Set();
  const importedUiTypes = new Set();
  const importedApiTypes = new Set();
  const functions = new Map();
  const objectLiterals = new Map();
  const contextReturningFunctions = new Set();
  const uiReturningFunctions = new Set();

  function isIdentifierAlias(node, aliases) {
    const key = bindingKey(node);
    return Boolean(key) && aliases.has(key);
  }
  function isApi(node) {
    return isIdentifierAlias(node, apiAliases);
  }
  function isContext(node) {
    node = unwrap(node);
    if (isIdentifierAlias(node, contextAliases)) return true;
    return Boolean(node && ts.isCallExpression(node) && isIdentifierAlias(node.expression, contextReturningFunctions));
  }
  function isUi(node) {
    node = unwrap(node);
    if (isIdentifierAlias(node, uiAliases)) return true;
    if (propertyName(node) === "ui" && isContext(propertyBase(node))) return true;
    return Boolean(node && ts.isCallExpression(node) && isIdentifierAlias(node.expression, uiReturningFunctions));
  }
  function setterReference(node) {
    const name = propertyName(node);
    return name && setters.has(name) && isUi(propertyBase(node)) ? name : undefined;
  }
  function isComponent(node) {
    node = unwrap(node);
    return isIdentifierAlias(node, componentAliases)
      || Boolean(node && componentTargets.has(propertyName(node)) && isIdentifierAlias(propertyBase(node), namespaceAliases));
  }
  function isPrototype(node) {
    node = unwrap(node);
    return isIdentifierAlias(node, prototypeAliases) || (propertyName(node) === "prototype" && isComponent(propertyBase(node)));
  }
  function isDefineProperty(node) {
    node = unwrap(node);
    if (isIdentifierAlias(node, definePropertyAliases)) return true;
    const base = propertyBase(node);
    return propertyName(node) === "defineProperty" && base && ts.isIdentifier(base) && base.text === "Object" && !bindingKey(base);
  }
  function importModule(node) {
    let current = node.parent;
    while (current && !ts.isImportDeclaration(current)) current = current.parent;
    return current && ts.isStringLiteralLike(current.moduleSpecifier) ? current.moduleSpecifier.text : undefined;
  }
  function typeHasImported(typeNode, aliases, targets) {
    if (!typeNode) return false;
    let found = false;
    function visit(node) {
      if (found) return;
      if (ts.isTypeReferenceNode(node)) {
        const name = node.typeName;
        if (ts.isIdentifier(name) && aliases.has(bindingKey(name))) found = true;
        else if (ts.isQualifiedName(name) && ts.isIdentifier(name.left) && namespaceAliases.has(bindingKey(name.left)) && targets.has(name.right.text)) found = true;
      }
      ts.forEachChild(node, visit);
    }
    visit(typeNode);
    return found;
  }
  function isDefaultExportFunction(node) {
    if (!ts.isFunctionDeclaration(node) && !ts.isFunctionExpression(node) && !ts.isArrowFunction(node)) return false;
    if (ts.isFunctionDeclaration(node)) {
      const modifiers = node.modifiers ?? [];
      return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        && modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    }
    return Boolean(node.parent && ts.isExportAssignment(node.parent) && node.parent.expression === node);
  }
  function isCommonJsExport(node) {
    node = unwrap(node);
    const base = propertyBase(node);
    const name = propertyName(node);
    return Boolean(base && ts.isIdentifier(base) && !bindingKey(base)
      && ((base.text === "module" && name === "exports") || (base.text === "exports" && name === "default")));
  }
  function resolveFunction(node) {
    node = unwrap(node);
    if (!node) return undefined;
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) return node;
    return ts.isIdentifier(node) ? functions.get(bindingKey(node)) : undefined;
  }
  function resolveObjectLiteral(node, seen = new Set()) {
    node = unwrap(node);
    if (!node) return undefined;
    if (ts.isObjectLiteralExpression(node)) return node;
    const key = bindingKey(node);
    if (!key || seen.has(key)) return undefined;
    seen.add(key);
    const value = objectLiterals.get(key);
    return value ? resolveObjectLiteral(value, seen) : undefined;
  }
  function objectHandler(node) {
    const object = resolveObjectLiteral(node);
    if (!object) return undefined;
    for (const property of object.properties) {
      const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) ? property.name.text : undefined;
      if (name !== "handler") continue;
      if (ts.isMethodDeclaration(property)) return property;
      if (ts.isPropertyAssignment(property)) return resolveFunction(property.initializer);
      if (ts.isShorthandPropertyAssignment(property)) return functions.get(bindingKey(property.name));
    }
    return undefined;
  }
  function seedIdentifier(name, aliases) {
    const key = bindingKey(name);
    if (!key || aliases.has(key)) return false;
    aliases.add(key);
    return true;
  }
  function seedParameter(parameter, kind) {
    if (!parameter) return false;
    const aliases = kind === "api" ? apiAliases : kind === "context" ? contextAliases : uiAliases;
    return seedIdentifier(parameter.name, aliases);
  }
  function seedHandler(call) {
    const method = propertyName(call.expression);
    if (!method || !isApi(propertyBase(call.expression))) return false;
    let handler;
    let contextIndex;
    if (method === "on") {
      handler = resolveFunction(call.arguments[1]);
      contextIndex = 1;
    } else if (method === "registerCommand") {
      handler = objectHandler(call.arguments[1]);
      contextIndex = 1;
    } else if (method === "registerShortcut") {
      handler = objectHandler(call.arguments[1]);
      contextIndex = 0;
    } else {
      return false;
    }
    return Boolean(handler) && seedParameter(handler.parameters[contextIndex], "context");
  }
  function bindIdentifier(name, initializer) {
    const key = bindingKey(name);
    if (!key || !initializer) return false;
    let changed = false;
    if (isApi(initializer) && !apiAliases.has(key)) changed = apiAliases.add(key) || changed;
    if (isContext(initializer) && !contextAliases.has(key)) changed = contextAliases.add(key) || changed;
    if (isUi(initializer) && !uiAliases.has(key)) changed = uiAliases.add(key) || changed;
    const setter = setterReference(initializer);
    if ((setter || isIdentifierAlias(initializer, setterAliases)) && !setterAliases.has(key)) changed = setterAliases.add(key) || changed;
    if (isComponent(initializer) && !componentAliases.has(key)) changed = componentAliases.add(key) || changed;
    if (isPrototype(initializer) && !prototypeAliases.has(key)) changed = prototypeAliases.add(key) || changed;
    if (isDefineProperty(initializer) && !definePropertyAliases.has(key)) changed = definePropertyAliases.add(key) || changed;
    if (isIdentifierAlias(initializer, namespaceAliases) && !namespaceAliases.has(key)) changed = namespaceAliases.add(key) || changed;
    return changed;
  }
  function bindObjectPattern(pattern, initializer, typedContext = false, typedUi = false) {
    if (!ts.isObjectBindingPattern(pattern)) return false;
    let changed = false;
    for (const element of pattern.elements) {
      const imported = element.propertyName ? (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName) ? element.propertyName.text : undefined) : ts.isIdentifier(element.name) ? element.name.text : undefined;
      if (!imported || !ts.isIdentifier(element.name)) continue;
      const key = bindingKey(element.name);
      if (imported === "ui" && (typedContext || (initializer && isContext(initializer))) && !uiAliases.has(key)) changed = uiAliases.add(key) || changed;
      if (setters.has(imported) && (typedUi || (initializer && isUi(initializer))) && !setterAliases.has(key)) changed = setterAliases.add(key) || changed;
      if (componentTargets.has(imported) && initializer && isIdentifierAlias(initializer, namespaceAliases) && !componentAliases.has(key)) changed = componentAliases.add(key) || changed;
      const builtinObject = initializer && ts.isIdentifier(unwrap(initializer)) && unwrap(initializer).text === "Object" && !bindingKey(initializer);
      if (imported === "defineProperty" && builtinObject && !definePropertyAliases.has(key)) changed = definePropertyAliases.add(key) || changed;
    }
    return changed;
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (ts.isImportSpecifier(node) && importModule(node) === piPackage) {
        const imported = (node.propertyName ?? node.name).text;
        const key = bindingKey(node.name);
        if (contextTypes.has(imported) && !importedContextTypes.has(key)) changed = importedContextTypes.add(key) || changed;
        if (uiTypes.has(imported) && !importedUiTypes.has(key)) changed = importedUiTypes.add(key) || changed;
        if (apiTypes.has(imported) && !importedApiTypes.has(key)) changed = importedApiTypes.add(key) || changed;
        if (componentTargets.has(imported) && !componentAliases.has(key)) changed = componentAliases.add(key) || changed;
      } else if (ts.isNamespaceImport(node) && importModule(node) === piPackage && !namespaceAliases.has(bindingKey(node.name))) {
        changed = namespaceAliases.add(bindingKey(node.name)) || changed;
      } else if (ts.isTypeAliasDeclaration(node)) {
        const key = bindingKey(node.name);
        if (typeHasImported(node.type, importedContextTypes, contextTypes) && !importedContextTypes.has(key)) changed = importedContextTypes.add(key) || changed;
        if (typeHasImported(node.type, importedUiTypes, uiTypes) && !importedUiTypes.has(key)) changed = importedUiTypes.add(key) || changed;
        if (typeHasImported(node.type, importedApiTypes, apiTypes) && !importedApiTypes.has(key)) changed = importedApiTypes.add(key) || changed;
      } else if (ts.isParameter(node) || ts.isVariableDeclaration(node)) {
        const typedContext = typeHasImported(node.type, importedContextTypes, contextTypes);
        const typedUi = typeHasImported(node.type, importedUiTypes, uiTypes);
        if (typedContext) changed = seedIdentifier(node.name, contextAliases) || bindObjectPattern(node.name, undefined, true, false) || changed;
        if (typedUi) changed = seedIdentifier(node.name, uiAliases) || bindObjectPattern(node.name, undefined, false, true) || changed;
        if (typeHasImported(node.type, importedApiTypes, apiTypes)) changed = seedIdentifier(node.name, apiAliases) || changed;
        if (ts.isVariableDeclaration(node)) {
          if (ts.isIdentifier(node.name) && node.initializer && (ts.isFunctionExpression(unwrap(node.initializer)) || ts.isArrowFunction(unwrap(node.initializer)))) {
            const key = bindingKey(node.name);
            if (!functions.has(key)) changed = true;
            functions.set(key, unwrap(node.initializer));
          }
          if (ts.isIdentifier(node.name) && node.initializer && (ts.isObjectLiteralExpression(unwrap(node.initializer)) || ts.isIdentifier(unwrap(node.initializer)))) {
            const key = bindingKey(node.name);
            if (!objectLiterals.has(key)) changed = true;
            objectLiterals.set(key, node.initializer);
          }
          changed = bindIdentifier(node.name, node.initializer) || bindObjectPattern(node.name, node.initializer) || changed;
        }
      } else if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && isDefaultExportFunction(node)) {
        changed = seedParameter(node.parameters[0], "api") || changed;
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        const key = bindingKey(node.name);
        if (!functions.has(key)) changed = true;
        functions.set(key, node);
      } else if (ts.isExportAssignment(node)) {
        const exported = resolveFunction(node.expression);
        if (exported) changed = seedParameter(exported.parameters[0], "api") || changed;
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (isCommonJsExport(node.left)) {
          const exported = resolveFunction(node.right);
          if (exported) changed = seedParameter(exported.parameters[0], "api") || changed;
        }
        changed = bindIdentifier(unwrap(node.left), node.right) || changed;
      } else if (ts.isCallExpression(node)) {
        changed = seedHandler(node) || changed;
        const called = resolveFunction(node.expression);
        if (called) {
          node.arguments.forEach((argument, index) => {
            if (isContext(argument)) changed = seedParameter(called.parameters[index], "context") || changed;
            if (isUi(argument)) changed = seedParameter(called.parameters[index], "ui") || changed;
          });
        }
      } else if (ts.isReturnStatement(node) && node.expression) {
        let owner = node.parent;
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
        const name = owner && (owner.name && ts.isIdentifier(owner.name) ? bindingKey(owner.name)
          : owner.parent && ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name) ? bindingKey(owner.parent.name) : undefined);
        if (name && isContext(node.expression) && !contextReturningFunctions.has(name)) changed = contextReturningFunctions.add(name) || changed;
        if (name && isUi(node.expression) && !uiReturningFunctions.has(name)) changed = uiReturningFunctions.add(name) || changed;
      }
    }
  }

  for (const node of nodes) {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (setterReference(callee) || isIdentifierAlias(callee, setterAliases)) return true;
      if (isDefineProperty(callee) && node.arguments.length >= 2 && isPrototype(node.arguments[0])) {
        const key = unwrap(node.arguments[1]);
        if (ts.isStringLiteralLike(key) && key.text === "render") return true;
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrap(node.left);
      if (propertyName(left) === "render" && isPrototype(propertyBase(left))) return true;
    }
  }
  return false;
}

function isProductionSource(root, file) {
  const parts = path.relative(root, file).split(path.sep).slice(0, -1);
  if (parts.some((part) => nonproductionParts.has(part))) return false;
  const nestedModules = parts.filter((part) => part === "node_modules").length;
  const allowed = path.basename(root) === "npm" && parts[0] === "node_modules" ? 1 : 0;
  return nestedModules <= allowed;
}

function walk(root, visit) {
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name));
    } catch (error) {
      throw new Error(`unable to read third-party tree ${current}: ${error.message}`);
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile()) visit(target);
    }
  }
}

function npmName(spec) {
  spec = spec.slice(4).trim();
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    const version = spec.indexOf("@", slash + 1);
    return version === -1 ? spec : spec.slice(0, version);
  }
  const version = spec.indexOf("@");
  return version === -1 ? spec : spec.slice(0, version);
}

function gitInstallPath(spec) {
  let value = spec.slice(4).trim().replace(/^git\+/, "");
  let host;
  let repoPath;
  try {
    if (/^[a-z]+:\/\//i.test(value)) {
      const url = new URL(value);
      host = url.hostname;
      repoPath = url.pathname.replace(/^\//, "");
    }
  } catch {}
  if (!host) {
    const scp = value.match(/^(?:[^@/]+@)?([^:/]+)[:/]([^#]+)$/);
    if (!scp) throw new Error(`unsupported enabled git package source: ${spec}`);
    [, host, repoPath] = scp;
  }
  const ref = repoPath.lastIndexOf("@");
  if (ref > repoPath.lastIndexOf("/")) repoPath = repoPath.slice(0, ref);
  repoPath = repoPath.replace(/\.git$/, "");
  return path.join(agentDir, "git", host, repoPath);
}

function enabledRoots(settingsPath) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(`unable to parse enabled package settings ${settingsPath}: ${error.message}`);
  }
  if (!Array.isArray(settings.packages)) throw new Error(`enabled package settings has no packages array: ${settingsPath}`);
  const roots = [];
  for (const entry of settings.packages) {
    const source = typeof entry === "string" ? entry : entry && typeof entry.source === "string" ? entry.source : undefined;
    if (!source) continue;
    if (source.startsWith("npm:")) roots.push(path.join(agentDir, "npm", "node_modules", npmName(source)));
    else if (source.startsWith("git:")) roots.push(gitInstallPath(source));
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function validateEnabledRoots(roots, cacheAgentDir) {
  const boundaries = [path.join(cacheAgentDir, "npm", "node_modules"), path.join(cacheAgentDir, "git")]
    .filter((boundary) => fs.existsSync(boundary))
    .map((boundary) => fs.realpathSync(boundary));
  const within = (target, boundary) => target === boundary || target.startsWith(boundary + path.sep);
  for (const root of roots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error(`enabled third-party package root is missing: ${root}`);
    }
    const realRoot = fs.realpathSync(root);
    if (!boundaries.some((boundary) => within(realRoot, boundary))) {
      throw new Error(`enabled third-party package escapes npm/git cache: ${root} -> ${realRoot}`);
    }
    const manifest = path.join(root, "package.json");
    if (!fs.existsSync(manifest) || !fs.statSync(manifest).isFile()) {
      throw new Error(`enabled third-party package has no root manifest: ${root}`);
    }
    let productionSources = 0;
    walk(root, (file) => {
      if (sourceSuffixes.has(path.extname(file).toLowerCase()) && isProductionSource(root, file)) productionSources++;
    });
    if (productionSources === 0) {
      throw new Error(`enabled third-party package has no scannable production source: ${root}`);
    }
  }
}

function scan(roots, enabled) {
  let manifests = 0;
  let sources = 0;
  const owners = [];
  for (const root of roots) {
    walk(root, (file) => {
      if (path.basename(file) === "package.json") manifests++;
      if (!sourceSuffixes.has(path.extname(file).toLowerCase())) return;
      sources++;
      if (!isProductionSource(root, file)) return;
      let source;
      try {
        source = fs.readFileSync(file, "utf8");
      } catch (error) {
        throw new Error(`unable to read third-party source ${file}: ${error.message}`);
      }
      if (sourceHasOwner(source, file)) {
        const resolved = path.resolve(file);
        owners.push({ path: resolved, enabled: enabled.some((packageRoot) => resolved === packageRoot || resolved.startsWith(packageRoot + path.sep)) });
      }
    });
  }
  owners.sort((a, b) => a.path.localeCompare(b.path));
  return { manifests, sources, owners };
}

function selfTest() {
  const positives = [
    ["import type { ExtensionContext } from '@earendil-works/pi-coding-agent'; function register(scope: ExtensionContext) { scope.ui.setHeader(() => null); }", "ts"],
    ["import type { ExtensionContext } from '@earendil-works/pi-coding-agent'; function register(scope: ExtensionContext) { scope.ui.\n  setFooter \n  (() => null); }", "ts"],
    ["import type { ExtensionContext } from '@earendil-works/pi-coding-agent'; function register(scope: ExtensionContext) { scope.ui['setHeader'](() => null); }", "ts"],
    ["export default function (host) { host.on('session_start', (_event, runtime) => runtime.ui?.setEditorComponent(Editor)); }", "js"],
    ["import type { ExtensionContext } from '@earendil-works/pi-coding-agent'; function register(scope: ExtensionContext) { (scope.ui as any).setHeader(() => null); }", "ts"],
    ["import type { ExtensionContext } from '@earendil-works/pi-coding-agent'; function register(scope: ExtensionContext) { const { setFooter: footer } = scope.ui; footer(() => null); }", "ts"],
    ["import type { ExtensionContext } from '@earendil-works/pi-coding-agent'; function register(scope: ExtensionContext) { const setter = scope.ui.setHeader; const alias = setter; alias(() => null); }", "ts"],
    ["export default function (host) { host.on('session_start', (_event, arbitraryName) => arbitraryName.ui.setHeader(() => null)); }", "js"],
    ["export default function (host) { host.on('session_start', (_event, runtime) => { const context = runtime; context.ui.setFooter(() => null); }); }", "js"],
    ["export default function (host) { host.on('session_start', (_event, runtime) => { const { ui: surface } = runtime; surface.setFooter(() => null); }); }", "js"],
    ["import type { ExtensionContext } from '@earendil-works/pi-coding-agent'; function register(context: ExtensionContext) { const surface = context.ui; surface.setHeader(() => null); }", "ts"],
    ["import type { ExtensionUIContext as Surface } from '@earendil-works/pi-coding-agent'; function install(surface: Surface) { surface.setEditorComponent(Editor); }", "ts"],
    ["import type { ExtensionContext } from '@earendil-works/pi-coding-agent'; function helper(value) { value.ui.setHeader(() => null); } function install(scope: ExtensionContext) { helper(scope); }", "ts"],
    ["import type { ExtensionContext } from '@earendil-works/pi-coding-agent'; function pickUi(value) { return value.ui; } function install(scope: ExtensionContext) { pickUi(scope).setFooter(() => null); }", "ts"],
    ["export default function (host) { host.registerCommand('owner', { handler(_args, commandScope) { commandScope.ui.setHeader(() => null); } }); }", "js"],
    ["const shortcut = { handler(shortcutScope) { shortcutScope.ui.setFooter(() => null); } }; export default function (host) { host.registerShortcut('ctrl+x', shortcut); }", "js"],
    ["function extension(host) { host.on('session_start', (_event, runtime) => runtime.ui.setHeader(() => null)); } export default extension;", "js"],
    ["function extension(host) { host.on('session_start', (_event, runtime) => runtime.ui.setFooter(() => null)); } module.exports = extension;", "cjs"],
    ["import { UserMessageComponent as U } from '@earendil-works/pi-coding-agent'; U.prototype.render = wrapped;", "ts"],
    ["import * as Pi from '@earendil-works/pi-coding-agent'; Pi.ToolExecutionComponent.prototype.render = wrapped;", "ts"],
    ["import { ToolExecutionComponent } from '@earendil-works/pi-coding-agent'; const Component = ToolExecutionComponent; const proto = Component.prototype; const define = Object.defineProperty; define(proto, 'render', { value: wrapped });", "ts"],
    ["import * as Pi from '@earendil-works/pi-coding-agent'; const { UserMessageComponent: Component } = Pi; const proto = Component.prototype; Object.defineProperty(proto, 'render', { value: wrapped });", "ts"],
  ];
  positives.forEach(([source, extension], index) => {
    if (!sourceHasOwner(source, `positive-${index}.${extension}`)) throw new Error(`AST positive case ${index + 1} was missed`);
  });
  const negatives = [
    "// scope.ui.setHeader(() => null);\nconst safe = 1;",
    'const sample = "scope.ui.setFooter(() => null)";',
    "other.setHeader(() => null); unrelated.defineProperty(value, 'render', {});",
    "const ui={setHeader(){}}; ui.setHeader()",
    "class UserMessageComponent {}; UserMessageComponent.prototype.render=wrapped",
    "const wrapper = { ui: { setFooter() {} } }; wrapper.ui.setFooter();",
    "import { ToolExecutionComponent } from 'somewhere-else'; ToolExecutionComponent.prototype.render = wrapped;",
    "import type { ExtensionContext } from '@earendil-works/pi-coding-agent'; function host(scope: ExtensionContext) {} function local() { const scope = { ui: { setHeader() {} } }; scope.ui.setHeader(); }",
    "import { UserMessageComponent } from '@earendil-works/pi-coding-agent'; function local() { class UserMessageComponent {}; UserMessageComponent.prototype.render = wrapped; }",
  ];
  negatives.forEach((source, index) => {
    if (sourceHasOwner(source, `negative-${index}.ts`)) throw new Error(`AST negative case ${index + 1} was rejected`);
  });

  let rootRejections = 0;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-ui-owners."));
  try {
    const npm = path.join(temp, "npm");
    const enabled = path.join(npm, "node_modules", "enabled-owner");
    const disabled = path.join(npm, "node_modules", "disabled-owner");
    fs.mkdirSync(enabled, { recursive: true });
    fs.mkdirSync(disabled, { recursive: true });
    fs.writeFileSync(path.join(enabled, "package.json"), '{}\n');
    fs.writeFileSync(path.join(disabled, "package.json"), '{}\n');
    fs.writeFileSync(path.join(enabled, "index.js"), "export default function (host) { host.on('session_start', (_event, scope) => scope.ui.setHeader(() => null)); }\n");
    fs.writeFileSync(path.join(disabled, "index.ts"), "import type { ExtensionContext } from '@earendil-works/pi-coding-agent'; function install(scope: ExtensionContext) { scope.ui.setFooter(() => null); }\n");
    const result = scan([npm], [path.resolve(enabled)]);
    validateEnabledRoots([path.resolve(enabled)], temp);

    const missing = path.join(npm, "node_modules", "missing-owner");
    const outside = path.join(temp, "outside-owner");
    const outsideLink = path.join(npm, "node_modules", "outside-owner");
    const noManifest = path.join(npm, "node_modules", "no-manifest");
    const noProduction = path.join(npm, "node_modules", "no-production");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "package.json"), '{}\n');
    fs.writeFileSync(path.join(outside, "index.ts"), "export {};\n");
    fs.symlinkSync(outside, outsideLink, "dir");
    fs.mkdirSync(noManifest, { recursive: true });
    fs.writeFileSync(path.join(noManifest, "index.ts"), "export {};\n");
    fs.mkdirSync(path.join(noProduction, "tests"), { recursive: true });
    fs.writeFileSync(path.join(noProduction, "package.json"), '{}\n');
    fs.writeFileSync(path.join(noProduction, "tests", "index.ts"), "export {};\n");
    const rootCases = [
      [missing, /root is missing/],
      [outsideLink, /escapes npm\/git cache/],
      [noManifest, /no root manifest/],
      [noProduction, /no scannable production source/],
    ];
    rootRejections = rootCases.filter(([root, pattern]) => {
      try {
        validateEnabledRoots([root], temp);
        return false;
      } catch (error) {
        return pattern.test(String(error));
      }
    }).length;
    if (rootRejections !== rootCases.length) throw new Error(`enabled root rejection mismatch: rejected=${rootRejections}`);

    const enabledOwners = result.owners.filter((owner) => owner.enabled);
    const disabledOwners = result.owners.filter((owner) => !owner.enabled);
    if (result.manifests !== 2 || result.sources !== 2 || enabledOwners.length !== 1 || disabledOwners.length !== 1) {
      throw new Error(`enabled/disabled classification mismatch: ${JSON.stringify(result)}`);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`third-party UI owner audit self-test passed: ast_positive=${positives.length} ast_negative=${negatives.length} enabled=1 disabled=1 root_rejections=${rootRejections}`);
}

try {
  selfTest();
  if (selfTestOnly) process.exit(0);
  const enabled = enabledRoots(settingsPath);
  validateEnabledRoots(enabled, agentDir);
  const result = scan([path.join(agentDir, "npm"), path.join(agentDir, "git")], enabled);
  const enabledOwners = result.owners.filter((owner) => owner.enabled);
  const disabledOwners = result.owners.filter((owner) => !owner.enabled);
  const summary = `available_manifests=${result.manifests} available_sources=${result.sources} available_owners=${result.owners.length} enabled_package_roots=${enabled.length} enabled_owners=${enabledOwners.length} disabled_owners=${disabledOwners.length}`;
  for (const owner of disabledOwners) console.log(`disabled installed owner (non-blocking): ${owner.path}`);
  if (enabledOwners.length) {
    console.error(`third-party UI owner audit failed: ${summary}`);
    for (const owner of enabledOwners) console.error(owner.path);
    process.exit(1);
  }
  console.log(`third-party UI owner audit passed: ${summary}`);
} catch (error) {
  console.error(`third-party UI owner audit failed closed: ${error.stack || error}`);
  process.exit(1);
}
JS
