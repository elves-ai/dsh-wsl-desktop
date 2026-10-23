# dsh-pet provenance

- Repository / required original-author attribution: <https://github.com/PC2005-cloud/dsh-pet>
- Commit: [bbf9dd800c8e5d4dc8cd2209c537b28808465c52](<https://github.com/PC2005-cloud/dsh-pet/tree/bbf9dd800c8e5d4dc8cd2209c537b28808465c52>)
- Source code copyright: Copyright (c) 2026 PC2005-cloud; original [MIT LICENSE](<./LICENSE>) is retained verbatim.
- Original README licensing section: [README-LICENSE](<./README-LICENSE.md>), copied verbatim.
- Animations: original WebM bytes, with no transcoding or editing. Assets allow open-source use and **prohibit commercial use**; do not describe the entire bundled app (including these assets) as unrestricted MIT.
- Derivative / modified / reskinned works: **every introduction, display, and distribution location** must include <https://github.com/PC2005-cloud/dsh-pet>. This applies to screenshots/videos, release/download pages, app surfaces, documentation, and redistributed copies.

## Imported scope and adaptations

- Seven modules from upstream dsh-pet/src/shared: types.ts, constants.ts, displays.ts, pickers.ts, motion.ts, physics.ts, work-status.ts. Source contents are unchanged except relative import specifiers gain a .ts extension for Node/Vite compatibility. Types and comments mentioning host/Electron/config fields are original documentation only; no Electron or host runtime is imported.
- All 106 files from upstream dsh-pet/assets/webm are copied byte-for-byte.
- Upstream dsh-pet/assets/config.jsonc is parsed as JSONC, then only animations, animationWeights, and physics are serialized to the bundled configuration. The renderer TypeScript export contains exactly those data sections plus local asset URL resolution and attribution constants. No upstream prompt text, model/provider settings, tokens, credentials, private configuration, API server, or Electron runtime is copied.
- The original config source is identified by SHA-256 in the [manifest](<./manifest.json>); the original full config is deliberately not bundled.
- Public notices, license, README license excerpt, provenance, and the manifest accompany the assets so Vite distribution retains them.

## Hash verification

The [manifest](<./manifest.json>) records all files in the vendor source directory, public asset directory, this provenance directory, and the generated renderer config. Each entry has a repository-relative path, byte count, and SHA-256; copied/adapted upstream entries additionally identify their source path and original hash. For adapted TypeScript, removing only .ts from relative import specifiers must recover the upstream hash. Both identical manifest copies are excluded from their own file list to avoid self-reference. Test code is not third-party payload and is not listed.

## Declarations required elsewhere in the application

Maintain the following in Chinese and English READMEs, assistant documentation, license summaries, release/download/distribution pages, screenshots/videos, and every pet display surface:

> Pet code and animations originate from dsh-pet by PC2005-cloud: <https://github.com/PC2005-cloud/dsh-pet>. Code is MIT (Copyright (c) 2026 PC2005-cloud); animation assets allow open-source use but prohibit commercial use. Derivative/modified/reskinned works must include this original-author GitHub URL everywhere they are introduced, displayed, or distributed.

> 桌宠代码与动画来自 PC2005-cloud 的 dsh-pet：<https://github.com/PC2005-cloud/dsh-pet>。代码采用 MIT（Copyright (c) 2026 PC2005-cloud）；动画素材允许开源使用、禁止商用。衍生、改版、换皮作品须在任何介绍、展示、分发处附上此原作者 GitHub 地址。

Privacy documentation should say these are packaged local animations and pure computations, not an embedded Electron/DSH host or an upstream LLM/prompt service. Do not claim this imports upstream conversation/model settings.
