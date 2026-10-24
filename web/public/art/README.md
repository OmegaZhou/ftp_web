# FTP Web 美术素材

此目录是正式 Web 的素材单一入口。资产清单见 `manifest.json`；它替代原型 HTML 中的内嵌 data URL 与固定三项选择表。前端只读取清单中列出的运行素材，按需加载当前角色、场景与装扮缩略图。

## 角色与署名

角色为成年 GPT 龙娘的 AI 同人演绎；沿用银白长发、淡紫瞳、白紫龙角/翼/尾和白玫瑰身份特征。界面保留轻量署名 **角色原案 ZipZipPipe · AI 同人演绎**，链接 https://space.bilibili.com/4168597 。不声称官方作品、作者委托或授权；不下载、复制第三方作品像素。

社区形象参考与前序研究记录在 `../../../../.codex/tasks/task_001/task.md`；本文件只维护实际素材、生成提示和编码，不复制产品需求。

## 运行素材

| 名称 | 文件 | 尺寸 | 字节 |
| --- | --- | --- | ---: |
| 资料室管理员 | `dragon-art.avif` | 1024 × 1536 | 135,089 |
| 今日值日 | `dragon-wave.avif` | 1024 × 1536 | 150,815 |
| 课后思考 | `dragon-think.avif` | 1024 × 1536 | 154,672 |
| 星月魔女 | `dragon-witch.avif` | 1024 × 1536 | 327,597 |
| 夏夜浴衣 | `dragon-yukata.avif` | 1024 × 1536 | 285,143 |
| 冬日学院 | `dragon-winter.avif` | 1024 × 1536 | 258,176 |
| 晴日资料室 | `scene-art.webp` | 900 × 507 | 45,816 |
| 夕暮资料室 | `scene-sunset.webp` | 900 × 507 | 49,440 |
| 星夜资料室 | `scene-night.webp` | 900 × 507 | 56,906 |
| 星月藏书阁 | `scene-library.webp` | 1672 × 941 | 451,082 |
| 灯笼庭院 | `scene-garden.webp` | 1672 × 941 | 475,542 |
| 雪日阅读室 | `scene-snow.webp` | 1672 × 941 | 366,688 |
| Q版龙娘 | `dragon-pet-actions.avif` | 600 × 400 | 50,989 |

`manifest.json` 的 `src` 与 `url` 均为相对本目录的文件名，调用端拼接 `BASE_URL + 'art/'`。每项含稳定 `id`、`name`、`type`、尺寸及字节信息；场景 `tone: day | night` 用于调整角色区标题对比。Q 宠图集为 3 列 × 2 行，顺序为 idle / wave / walk / jump / sleep / drag。

## 生成与编码

- 全部图片由内置 imagegen 生成；本轮没有使用 CLI 或外部 API fallback。
- 2026-10-23 的三立绘、三场景和六格 Q 宠沿用已验收的编码版本；三张主立绘保留 1024 × 1536，以 AVIF quality 60 / 4:4:4 编码。旧背景宽 900，Q 宠图集 600 × 400。
- 2026-10-24 新增星月魔女、夏夜浴衣、冬日学院三张独立服装立绘，以及星月藏书阁、灯笼庭院、雪日阅读室三张独立背景。每套为独立图，非拼图。
- 新立绘原始 PNG 为 1024 × 1536 RGBA，使用 sharp AVIF `{quality:85, effort:6, chromaSubsampling:'4:4:4'}` 编码，未缩放、裁切、锐化、重绘或合成，透明 alpha 保留。
- 新场景原始 PNG 为 1672 × 941 RGB（约 16:9），使用 sharp WebP `{quality:90, effort:6}` 原尺寸编码。
- 原始 PNG 已复制到本目录 `source/`，便于后续重新编码。它们是制作源文件，**不在 manifest 中，不应预加载；发布包可排除 source/**，运行只需要本目录的 AVIF/WebP 和 manifest。
- 主立绘应直接显示，不使用持续 scale、rotate、translate3d 或滤镜；切换可短暂淡入，环境动效由独立场景层承担。
- 核验：13 个运行文件均可解码，尺寸与清单一致；六张立绘为 RGBA，四角 alpha 均为 0。新服装人工查看确认身份一致、全身完整、服装可辨；三新场景无人物、文字或 UI。

## 新增素材最终提示词

以下为实际传给内置 imagegen 的完整提示词。立绘均通过 `referenced_image_paths` 引用已有管理员 PNG，事先使用 `view_image` 查看；场景为全新生成，没有引用输入图。三立绘 `transparent_background: true`；三场景为 false。

### dragon-witch

Use case: identity-preserve. Asset type: transparent anime full-body character illustration for a website wardrobe. Input image 1 is the identity and illustration-style reference only; preserve the same adult dragon woman, delicate face, violet eyes, very long silver-white hair, white/lavender curved dragon horns, white rose hair ornament, pointed ears, small pearly dragon wings and curled white dragon tail. Create a NEW independent full-body pose and outfit: a refined star-and-moon witch ensemble, a long midnight-lavender dress with silver star embroidery, closed high collar, fitted but modest bodice, flowing full skirt to the ankles, short soft white capelet, crescent brooch, lace cuffs, elegant boots. No hat covering the horns. She holds one small closed astronomy book with a warm knowing smile. High-end Japanese anime game key visual, delicate crisp clean line art, detailed luminous hair strands, controlled soft cel shading, silver and violet accents. Portrait canvas exactly 1024x1536; complete head, horns, wing tips, tail and both feet inside frame with generous transparent margins, centered standing pose readable at UI size. Genuine transparent alpha background, no opaque ground, no backdrop, no checkerboard baked in. No blur, no glow halo around cutout, no text, no logo, no watermark, no border, no additional characters. Preserve reference character identity but fully replace clothing as specified; avoid exposed cleavage or high slit.

### scene-library

Use case: stylized-concept. Asset type: atmospheric anime website background, one standalone scene. Primary request: an empty star-and-moon magical archive library at night, elegant tall arched windows framing a starry indigo sky and a gentle crescent moon, orderly bookshelves, a reading desk, brass astronomical instruments and several small hanging star ornaments. No people, no characters. High-end Japanese anime game environment illustration, delicate architectural detail, painterly but sharp fine lines, luminous moonlight in silver/lavender/indigo balanced with warm small desk lamps. Wide 16:9 landscape composition, quiet foreground and readable open center/right space for a translucent application panel, scene detail strongest along edges and windows. Refined comfortable reading room, coherent perspective, fully finished background to all edges. No typography, no readable book text, no signs, no logos, no watermark, no border, no UI. Avoid heavy bloom and blur. A calm usable website backdrop rather than a chaotic fantasy poster.

### dragon-yukata

Use case: identity-preserve. Asset type: transparent full-body anime wardrobe illustration. Input image 1 is the identity and art-style reference only. Keep the same adult dragon woman: delicate face, violet eyes, extremely long silver-white hair, white/lavender curved dragon horns, white rose hair ornament, pointed ears, pearly white small dragon wings and a gracefully curled white dragon tail. Dress her in a distinctly different summer festival outfit: an elegant white and pale-lavender yukata with small wisteria and silver star motifs, a properly crossed modest collar, long flowing sleeves, lavender obi tied in a neat bow, simple pale sandals. She holds a closed white folding fan loosely in one hand near her waist; the other hand gently lifts one empty sleeve in a friendly relaxed gesture. No lantern prop. Mature adult proportions consistent with the reference. Polished high-end Japanese anime game illustration, crisp fine line art and luminous hair strands, delicate lavender shadows, fabric folds and embroidery clearly defined. Full-length portrait canvas exactly1024x1536, all horns, wings, tail and both sandal feet fully in frame with transparent margins. Genuine transparent alpha background, no shadow backdrop or opaque ground, no scenery, no checkerboard baked into pixels. No text, no logo, no watermark, no border, no extra character. No motion blur, no bloom halo, no cleavage, no high skirt slit. Preserve character identity; outfit must read as a yukata, not the reference qipao.

### scene-garden

Use case: stylized-concept. Asset type: anime website background scene, landscape16:9. Primary request: a peaceful empty Japanese-inspired courtyard on a summer night, viewed from a covered wooden veranda. A neat garden path curves by a small reflecting pond, wisteria vines hang lightly from a wooden trellis, a few warm paper lanterns illuminate the garden and veranda. Beyond are a quiet traditional reading pavilion and deep indigo starry sky. No people, no silhouettes, no festival crowds. High-end Japanese anime game environment painting, detailed wood and garden textures, crisp painterly linework, restrained pale lavender/cool blue moonlight contrasted with small warm amber lights. Calm comfortable summer atmosphere. Wide coherent16:9 composition; open foreground veranda and uncrowded center/right make room for a translucent file-manager UI. Keep decoration mostly at edges, no oversized focal object. No text, no signage, no logos, no watermark, no border, no UI, no motion blur or excessive bloom.

### dragon-winter

Use case: identity-preserve. Asset type: transparent anime full-body winter wardrobe illustration for a web companion. Input image1 is the identity and delicate illustration-style reference. Keep exactly the same adult dragon woman: violet eyes, very long silver-white hair, white/lavender curved dragon horns, white rose hair ornament, pointed ears, pearly dragon wings and white curved dragon tail. A new distinctly winter academic outfit: a tailored knee-length cream wool duffle coat with lavender lining and silver toggles, a long soft pale-lavender knitted scarf, dark violet pleated skirt peeking below the coat, opaque cream tights, neatly fitted winter ankle boots, small silver snowflake brooch and lavender mittens. Closed coat and high scarf; modest comfortable clothing. She gently clasps a small closed book in both mittened hands at waist level, warm welcoming expression. No hat, no hood covering horns. High-end Japanese anime game illustration matching reference quality: crisp precise fine linework, luminous silver hair strands, delicate but clear cel shading, detailed knit and wool textures, elegant balanced silhouette. Portrait canvas exactly1024x1536, full body head-to-boots, all horns, wing tips, tail and both feet visible inside transparent margins. Real transparent alpha background with no snow scene or ground or opaque shadow, no baked checkerboard, no text, no logo, no watermark, no border, no additional people. Avoid motion blur, heavy glow, cleavage and exposed legs. Clothing must clearly read as a winter school coat and scarf, not the original dress.

### scene-snow

Use case: stylized-concept. Asset type: anime website background, a single standalone wide16:9 landscape scene. Primary request: an empty cozy academy reading room beside large white-paned windows on a snowy winter afternoon. Outside the windows, snow covers a peaceful garden and distant academy rooftops; a few delicate snowflakes drift past. Indoors: warm oak bookshelves along the edges, a broad clear reading table with a closed lavender book and a simple ceramic cup at the edge, upholstered window bench with folded throw, soft amber desk lamps. No people, no animals, no silhouettes. High-end Japanese anime game environment illustration, detailed clean fine linework, pale silver-blue snowy daylight and gentle warm cream interior, crisp atmosphere without haze. Wide coherent perspective and16:9 composition; uncrowded open center/right and restrained foreground suitable for a translucent file-management application overlay. Main decorative detail at room edges; comfortable quiet space, not a Christmas advertisement. No typography, no readable book text, no signs, no branding, no watermark, no frame, no UI. Avoid excessive blur, bloom, or large foreground objects.

## 前序素材提示摘要

前序完整对话生成记录位于任务历史，以下仅为已有文件的提示摘要，不将其冒充原始完整提示词。

- `dragon-art`：成年白紫 GPT 龙娘、完整龙角翼尾、旗袍、手持资料书、全身透明背景。
- `dragon-wave`：同一 GPT 龙娘、学院值日服、招手欢迎姿态、全身透明背景。
- `dragon-think`：同一 GPT 龙娘、针织开衫、课后思考姿态、全身透明背景。
- `dragon-pet-actions`：同一银白发白紫龙娘 Q 版，3 × 2 网格六姿势 idle / wave / walk / jump / sleep / drag，透明背景。
- `scene-art`：明亮海边学院资料室、落地窗、蓝天与海面、轻盈室内，无人物/文字。
- `scene-sunset`：同一海边资料室的放学夕照、暖金天空与室内光线，无人物/文字。
- `scene-night`：同一海边资料室的星空与灯火、冷暖照明层次，无人物/文字。

## 原图来源

下列 Codex 生成路径仅用于追溯；正式引用和重新编码均可使用仓库内对应的 `source/*.png`，不依赖用户本机缓存。

| 仓库原图 | 内置 imagegen 返回路径 |
| --- | --- |
| `source/dragon-art.png` | `C:/Users/Zhou/.codex/generated_images/01a16721-8eb9-7e72-aff9-cee6285b5c76/exec-b11f9de9-5d94-48f7-b723-39ffe5cd244c.png` |
| `source/dragon-wave.png` | `C:/Users/Zhou/.codex/generated_images/01a16721-8eb9-7e72-aff9-cee6285b5c76/exec-19033327-c8fe-4b7e-8d27-289878667cec.png` |
| `source/dragon-think.png` | `C:/Users/Zhou/.codex/generated_images/01a16721-8eb9-7e72-aff9-cee6285b5c76/exec-e46fb836-42c2-4283-99f6-edea07ecebef.png` |
| `source/dragon-pet-actions.png` | `C:/Users/Zhou/.codex/generated_images/01a16721-8eb9-7e72-aff9-cee6285b5c76/exec-f190ad9f-23e5-400c-ae0c-2d511a3a02e4.png` |
| `source/scene-art.png` | `C:/Users/Zhou/.codex/generated_images/01a16721-8eb9-7e72-aff9-cee6285b5c76/exec-141f783b-400c-4d49-a409-4cbfcaa27ef7.png` |
| `source/scene-sunset.png` | `C:/Users/Zhou/.codex/generated_images/01a16721-8eb9-7e72-aff9-cee6285b5c76/exec-bd738b92-8265-46bd-9876-97936d026d33.png` |
| `source/scene-night.png` | `C:/Users/Zhou/.codex/generated_images/01a16721-8eb9-7e72-aff9-cee6285b5c76/exec-e222140e-6f24-4b86-8682-a45884f6fabf.png` |
| `source/dragon-witch.png` | `C:/Users/Zhou/.codex/generated_images/01a16977-63ae-7ec2-9f39-f854bdb9df5a/exec-fcc30792-bbfb-4329-bbd9-4d369b4855cb.png` |
| `source/scene-library.png` | `C:/Users/Zhou/.codex/generated_images/01a16977-63ae-7ec2-9f39-f854bdb9df5a/exec-7028b3d0-c892-4eca-89f8-86606bf7eb0a.png` |
| `source/dragon-yukata.png` | `C:/Users/Zhou/.codex/generated_images/01a16977-63ae-7ec2-9f39-f854bdb9df5a/exec-5e84bd51-fff2-4195-9780-fa6f743be563.png` |
| `source/scene-garden.png` | `C:/Users/Zhou/.codex/generated_images/01a16977-63ae-7ec2-9f39-f854bdb9df5a/exec-13d69720-0115-4fb7-ba7a-c7f060f89487.png` |
| `source/dragon-winter.png` | `C:/Users/Zhou/.codex/generated_images/01a16977-63ae-7ec2-9f39-f854bdb9df5a/exec-ed9b961e-4880-44b4-b26b-61b93ddeec16.png` |
| `source/scene-snow.png` | `C:/Users/Zhou/.codex/generated_images/01a16977-63ae-7ec2-9f39-f854bdb9df5a/exec-a11fb271-4efe-45a1-bd4d-a2f04bd6b8a5.png` |

## 新增文件准入

- 必要性：正式 Web 需要独立、可缓存的真实图片和可维护的换装清单。
- 范围：只收纳本次 FTP Web 角色、场景、宠物素材及其制作来源。
- 归属：运行资源与维护记录集中在此目录，不额外建立需求文档。
- 可维护性：稳定 ID 与相对路径隔离前端代码；原图、提示词、编码参数可复现后处理。
- 新增即减法：本目录替代原型的内嵌图片与硬编码选择列表，README 合并素材来源、提示词和编码记录，避免为每套服装创建独立说明。
