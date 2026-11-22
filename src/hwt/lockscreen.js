import fs from 'node:fs';
import path from 'node:path';
import { compileAdaptiveXml } from '../compiler/xml_compiler.js';
import { transpileToThemeDOM } from '../ir/transpiler.js';
import { alignAdaptedNodeIds, validateAdaptedTheme } from '../validator/validator.js';
import { parseXml } from '../xml/parser.js';
import { AssetIndex } from './image_meta.js';
import { auditResourceReferences } from './resource_audit.js';
import { HwtArchive } from './zip.js';

const MANIFEST_PATHS = ['unlock/lockscreen/manifest.xml', 'unlock/ucdlockscreen/manifest.xml'];

export function listLockscreenManifests(archive) {
  return MANIFEST_PATHS.filter(manifestPath => archive.has(manifestPath));
}

export function loadLockscreen(archive, themeFile, manifestPath) {
  const rawXml = archive.readText(manifestPath);
  if (!rawXml) throw new Error(`Missing lockscreen manifest: ${themeFile} / ${manifestPath}`);
  const origDoc = parseXml(rawXml);
  const assetIndex = new AssetIndex(archive, path.posix.dirname(manifestPath) + '/');
  const themeName = manifestPath === MANIFEST_PATHS[0] ? themeFile : `${themeFile} [ucdlockscreen]`;
  const themeDOM = transpileToThemeDOM(origDoc, assetIndex, themeName, { packageName: themeFile, manifestPath });
  return { archive, manifestPath, origDoc, assetIndex, themeDOM };
}

export function loadPrimaryLockscreen(archive, themeFile) {
  const [manifestPath] = listLockscreenManifests(archive);
  if (!manifestPath) throw new Error(`No lockscreen manifest: ${themeFile}`);
  return loadLockscreen(archive, themeFile, manifestPath);
}

export function compileLockscreen(lockscreen, options) {
  const compiled = compileAdaptiveXml(lockscreen.origDoc, lockscreen.themeDOM, options);
  return { ...lockscreen, compiled, adaptedDoc: alignAdaptedNodeIds(parseXml(compiled.xml)) };
}

export function compileOtherLockscreens(primary, themeFile, options) {
  const { archive, manifestPath } = primary;
  return listLockscreenManifests(archive)
    .filter(other => other !== manifestPath)
    .map(other => compileLockscreen(loadLockscreen(archive, themeFile, other), options));
}

export function writeLockscreenDelivery(variants, outDir, { viewports, packageName = null } = {}) {
  const replacements = new Map(variants.map(variant => [
    variant.manifestPath, Buffer.from(variant.compiled.xml, 'utf8'),
  ]));
  let repacked = null;
  let readback = null;
  if (packageName) {
    repacked = variants[0].archive.repack(replacements);
    readback = new HwtArchive(repacked);
  }

  const scripts = variants.map(variant => {
    const { manifestPath, origDoc, themeDOM } = variant;
    const adaptedXml = readback ? readback.readText(manifestPath) : variant.compiled.xml;
    if (adaptedXml !== variant.compiled.xml) throw new Error(`Repacked manifest differs: ${manifestPath}`);
    const assetIndex = readback
      ? new AssetIndex(readback, variant.assetIndex.basePrefix)
      : variant.assetIndex;
    const validation = validateAdaptedTheme({ origDoc, adaptedXml, themeDOM, assetIndex, viewports });
    const sourceResources = auditResourceReferences(origDoc, variant.assetIndex);
    return { manifestPath, validation, sourceResources, layoutDiagnostics: variant.compiled.layoutDiagnostics };
  });

  const files = [];
  for (const [manifestPath, xml] of replacements) {
    const destination = path.join(outDir, manifestPath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, xml);
    files.push(manifestPath);
  }
  if (repacked) {
    fs.writeFileSync(path.join(outDir, packageName), repacked);
    files.push(packageName);
  }
  const audit = { packageName, packageReadBack: Boolean(readback), passed: scripts.every(script => script.validation.passed), scripts };
  fs.writeFileSync(path.join(outDir, 'delivery_audit.json'), JSON.stringify(audit, null, 2), 'utf8');
  return { files: [...files, 'delivery_audit.json'], audit };
}
