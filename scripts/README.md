# Scripts

## upload-photos.mjs

Copies local post photos to the public directory so they're served by the static site, then updates each Notion page's Cover Image property with the hosted URL.

### Folder structure

```
photos/
  gil-gamja-korean-chewy-potato-fries/
    cover.jpg           <- becomes the Cover Image in Notion
    1-ingredients.jpg   <- available at /images/posts/{slug}/1-ingredients.jpg
    2-cooking.jpg
    3-finished.jpg
  spam-kimchi-fried-rice/
    cover.jpg
    1-ingredients.jpg
    ...
```

Each folder name must match the post's **Slug** value in Notion exactly.

### Setup

```bash
# Create a photo folder for a post
mkdir -p photos/your-post-slug

# Add images (cover.jpg is used for the Notion Cover Image property)
cp ~/Desktop/my-cover.jpg photos/your-post-slug/cover.jpg
cp ~/Desktop/step1.jpg photos/your-post-slug/1-ingredients.jpg
```

### Usage

```bash
# Process all folders
NOTION_API_KEY=ntn_xxx node scripts/upload-photos.mjs

# Process one slug only
NOTION_API_KEY=ntn_xxx node scripts/upload-photos.mjs --slug=gil-gamja-korean-chewy-potato-fries

# Preview without making changes
NOTION_API_KEY=ntn_xxx node scripts/upload-photos.mjs --dry-run
```

### After running

```bash
git add public/images/posts/
git commit -m "Add post photos"
git push
```

Once deployed, the cover image URLs (e.g. `https://thehansang.sg/images/posts/{slug}/cover.jpg`) will be live and visible on the site.

### What it does

1. Reads all subfolders in `photos/`
2. Copies every `.jpg`, `.jpeg`, `.png`, `.webp` file to `public/images/posts/{slug}/`
3. Queries the Notion Posts database for a page matching each slug
4. If a `cover.*` file exists, updates the page's **Cover Image** property with the hosted URL

### Notes

- The Notion API does not support direct local file uploads. This script works around that by hosting images through the static site's `public/` directory.
- Missing slugs, missing Notion pages, and API errors produce warnings instead of crashes.
- The `--dry-run` flag lets you preview what would happen without side effects.

## sync-notion.mjs

Syncs published posts from Notion to Astro page files. See main project README for details.
