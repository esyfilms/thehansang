/**
 * Upload Photos to Notion Posts
 *
 * Copies local photos from photos/{slug}/ to public/images/posts/{slug}/
 * so they are served by the static site, then updates the Notion page's
 * Cover Image property with the hosted URL.
 *
 * Usage:
 *   NOTION_API_KEY=ntn_xxx node scripts/upload-photos.mjs
 *
 * Optional flags:
 *   --dry-run    Show what would happen without copying files or calling Notion
 *   --slug=xxx   Process only one specific slug folder
 */

import fs from 'fs';
import path from 'path';
import { Client } from '@notionhq/client';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const POSTS_DS_ID = '54bd1d7c-c34a-4351-aa57-f0137d946f8f';
const PHOTOS_DIR = path.resolve('photos');
const PUBLIC_IMAGES = path.resolve('public/images/posts');
const SITE_URL = 'https://thehansang.sg';
const IMAGE_EXT = /\.(jpg|jpeg|png|webp)$/i;

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const slugFlag = args.find(a => a.startsWith('--slug='));
const ONLY_SLUG = slugFlag ? slugFlag.split('=')[1] : null;

// ---------------------------------------------------------------------------
// Notion client
// ---------------------------------------------------------------------------

if (!process.env.NOTION_API_KEY) {
  console.error('Error: NOTION_API_KEY environment variable is required.');
  console.error('Usage: NOTION_API_KEY=ntn_xxx node scripts/upload-photos.mjs');
  process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getImageFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(f => IMAGE_EXT.test(f)).sort();
  } catch {
    return [];
  }
}

function getFolders(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter(f => {
        try {
          return fs.statSync(path.join(dir, f)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

async function findNotionPageBySlug(slug) {
  try {
    const response = await notion.databases.query({
      database_id: POSTS_DS_ID,
      filter: {
        property: 'Slug',
        rich_text: { equals: slug },
      },
    });
    return response.results.length > 0 ? response.results[0] : null;
  } catch (err) {
    console.warn(`  Warning: Notion query failed for slug "${slug}": ${err.message}`);
    return null;
  }
}

async function updateCoverImage(pageId, coverUrl, coverFileName) {
  try {
    await notion.pages.update({
      page_id: pageId,
      properties: {
        'Cover Image': {
          files: [{ name: coverFileName, external: { url: coverUrl } }],
        },
      },
    });
    return true;
  } catch (err) {
    console.warn(`  Warning: Failed to update Cover Image: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(PHOTOS_DIR)) {
    console.error(`Error: Photos directory not found at ${PHOTOS_DIR}`);
    console.error('Create it first: mkdir -p photos/your-post-slug');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('=== DRY RUN — no files will be copied, no Notion calls made ===\n');
  }

  let folders = getFolders(PHOTOS_DIR);

  if (ONLY_SLUG) {
    folders = folders.filter(f => f === ONLY_SLUG);
    if (folders.length === 0) {
      console.error(`Error: No folder found for slug "${ONLY_SLUG}" in ${PHOTOS_DIR}`);
      process.exit(1);
    }
  }

  if (folders.length === 0) {
    console.log('No photo folders found. Add folders to photos/ and try again.');
    return;
  }

  console.log(`Found ${folders.length} photo folder(s)\n`);

  let processed = 0;
  let skipped = 0;

  for (const slug of folders) {
    console.log(`--- ${slug} ---`);

    const srcDir = path.join(PHOTOS_DIR, slug);
    const destDir = path.join(PUBLIC_IMAGES, slug);
    const files = getImageFiles(srcDir);

    if (files.length === 0) {
      console.log('  No image files found, skipping.');
      skipped++;
      continue;
    }

    // Copy images to public directory
    if (!DRY_RUN) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    for (const file of files) {
      const src = path.join(srcDir, file);
      const dest = path.join(destDir, file);
      if (DRY_RUN) {
        console.log(`  [dry-run] Would copy ${file}`);
      } else {
        fs.copyFileSync(src, dest);
        console.log(`  Copied ${file}`);
      }
    }

    // Find the matching Notion page
    if (DRY_RUN) {
      console.log(`  [dry-run] Would query Notion for slug: ${slug}`);
    } else {
      const page = await findNotionPageBySlug(slug);
      if (!page) {
        console.warn(`  Warning: No Notion page found for slug "${slug}". Images copied but Notion not updated.`);
        skipped++;
        continue;
      }

      const pageId = page.id;

      // Update Cover Image if cover file exists
      const coverFile = files.find(f => f.match(/^cover\.(jpg|jpeg|png|webp)$/i));
      if (coverFile) {
        const coverUrl = `${SITE_URL}/images/posts/${slug}/${coverFile}`;
        const ok = await updateCoverImage(pageId, coverUrl, coverFile);
        if (ok) {
          console.log(`  Set Cover Image -> ${coverUrl}`);
        }
      } else {
        console.log('  No cover image found (expected cover.jpg/png/webp).');
      }
    }

    console.log(`  Done: ${files.length} image(s) processed.`);
    processed++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${processed}  Skipped: ${skipped}`);

  if (!DRY_RUN && processed > 0) {
    console.log('\nNext steps:');
    console.log('  1. git add public/images/posts/');
    console.log('  2. git commit -m "Add post photos"');
    console.log('  3. git push');
    console.log('  4. Wait for deploy, then cover image URLs will be live.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
