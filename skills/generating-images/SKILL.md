---
name: generating-images
description: "MUST be used when you need to generate images from text prompts using AI. Creates high-quality images with Gemini Imagen using customizable prompts, aspect ratios, and sizes. Perfect for creating artwork, illustrations, concept art, posters, banners, profile pictures, or any visual content. Triggers on: generate image, create image, make an image, image from prompt, AI art, generate picture, create artwork, make illustration, imagen, text to image, draw an image, visualize this, create visual, generate graphic, make poster, create banner."
---

# Generating Images

Generate high-quality images from text prompts using Gemini's Imagen model.

## When to Use

- User wants to create an image from a description
- Need artwork, illustrations, or concept art
- Creating posters, banners, or marketing materials
- Generating profile pictures or avatars
- Visualizing ideas or concepts
- Creating custom graphics for any purpose

## Available Scripts

When executing the script, `cd` to the skill folder first.

- **`scripts/generate.ts`** — Generates an image via Gemini 3 Pro Image model and saves as PNG

## Usage

```bash
cd ~/.claude/skills/generating-images
bun scripts/generate.ts "<prompt>" <output-path> [options]
```

### Arguments

- `<prompt>` — Text description of the image to generate (required, quoted)
- `<output-path>` — Where to save the PNG file (required)
- `--aspect-ratio <ratio>` — Image aspect ratio (optional, default: "1:1")
  - Options: "1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2"
- `--size <size>` — Image resolution (optional, default: "2K")
  - Options: "1K", "2K", "4K"

### Examples

```bash
cd ~/.claude/skills/generating-images

# Square image (default)
bun scripts/generate.ts "A serene mountain lake at sunset" ~/images/lake.png

# Widescreen landscape
bun scripts/generate.ts "Futuristic cityscape at night" ~/images/city.png --aspect-ratio 16:9 --size 4K

# Portrait orientation
bun scripts/generate.ts "Portrait of a wise elder" ~/images/portrait.png --aspect-ratio 2:3

# Phone wallpaper
bun scripts/generate.ts "Abstract geometric patterns" ~/images/wallpaper.png --aspect-ratio 9:16 --size 4K
```

## How It Works

1. Takes your text prompt
2. Sends it to Gemini 3 Pro Image model
3. Generates high-quality image based on the description
4. Saves as PNG to your specified location
5. Reports file size and success

## Requirements

- **GEMINI_API_KEY** environment variable must be set
- **Bun** runtime

## Tips for Good Prompts

- Be specific and descriptive
- Include style preferences (photorealistic, illustrated, watercolor, etc.)
- Mention lighting, mood, and atmosphere
- Describe composition and perspective
- Add details about colors and textures

### Example Prompts

**Photography style:**

```
"Professional photograph of a cozy coffee shop interior, warm lighting, wooden tables, plants in corners, soft bokeh background, shot with 35mm lens"
```

**Illustration style:**

```
"Whimsical watercolor illustration of a garden with butterflies, soft pastel colors, dreamy atmosphere, children's book style"
```

**Abstract/Artistic:**

```
"Abstract geometric composition with flowing curves, gradient from deep purple to electric blue, modern minimalist design"
```

**Concept Art:**

```
"Sci-fi space station interior, holographic displays, metallic surfaces, dramatic lighting through large windows showing stars, cinematic composition"
```

## Notes

- Images are generated at high quality (2K or 4K resolution)
- Aspect ratios match common use cases (social media, prints, screens)
- PNG format preserves quality and supports transparency
- Generation typically takes 10-30 seconds depending on complexity
- Each generation uses Gemini API credits
- The script auto-creates output directories if they don't exist
