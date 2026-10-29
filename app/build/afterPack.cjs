// electron-builder only embeds the exe icon through rcedit, which needs Wine off Windows.
// resedit patches the PE resources in pure JS, so Linux/macOS builds get the Slab icon too.
const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit/cjs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { load } = ResEdit;
  const RE = await load();
  const exePath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe');
  const exe = RE.NtExecutable.from(fs.readFileSync(exePath));
  const res = RE.NtExecutableResource.from(exe);
  const ico = RE.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = RE.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  RE.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map(i => i.data));

  const { version, productName } = context.packager.appInfo;
  const [vi] = RE.Resource.VersionInfo.fromEntries(res.entries);
  if (vi) {
    const parts = version.split('.').map(Number);
    vi.setFileVersion(...parts, 0, lang); vi.setProductVersion(...parts, 0, lang);
    vi.setStringValues({ lang, codepage: 1200 }, { ProductName: productName, FileDescription: productName, CompanyName: productName, OriginalFilename: productName + '.exe', InternalName: productName, LegalCopyright: '' });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
};
