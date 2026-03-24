/**
 * Notion → Astro Sync Script
 * Fetches posts from Notion Posts DB where Status = "Done"
 * Generates Astro page files from the content
 */

import { Client } from '@notionhq/client';
import fs from 'fs';
import path from 'path';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const POSTS_DB_ID = 'b933f3f3-cdd6-4c41-9909-0bfae6df37d9';
const POSTS_DS_ID = '54bd1d7c-c34a-4351-aa57-f0137d946f8f'; // data source ID
const PAGES_DIR = path.resolve('src/pages');

// Pillar → folder mapping
const PILLAR_FOLDERS = {
  'Eat': 'eat',
  'Cook': 'cook',
  'Travel': 'travel',
  'Culture': 'culture',
  'Events': 'events',
};

async function fetchPublishedPosts() {
  // v5 SDK uses dataSources.query instead of databases.query
  const response = await notion.dataSources.query({
    data_source_id: POSTS_DS_ID,
    filter: {
      and: [
        { property: 'Status', status: { equals: 'Done' } },
        { property: 'Kill Switch', checkbox: { equals: true } },
      ],
    },
    sorts: [{ property: 'Published Date', direction: 'descending' }],
  });
  return response.results;
}

function getProperty(page, name) {
  const prop = page.properties[name];
  if (!prop) return null;
  switch (prop.type) {
    case 'title': return prop.title.map(t => t.plain_text).join('');
    case 'rich_text': return prop.rich_text.map(t => t.plain_text).join('');
    case 'select': return prop.select?.name || null;
    case 'multi_select': return prop.multi_select.map(s => s.name);
    case 'number': return prop.number;
    case 'checkbox': return prop.checkbox;
    case 'url': return prop.url;
    case 'date': return prop.date?.start || null;
    case 'status': return prop.status?.name || null;
    case 'files': return prop.files.map(f => f.file?.url || f.external?.url).filter(Boolean);
    default: return null;
  }
}

async function getPageContent(pageId) {
  const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
  let markdown = '';

  for (const block of blocks.results) {
    switch (block.type) {
      case 'paragraph':
        markdown += richTextToMd(block.paragraph.rich_text) + '\n\n';
        break;
      case 'heading_1':
        markdown += '# ' + richTextToMd(block.heading_1.rich_text) + '\n\n';
        break;
      case 'heading_2':
        markdown += '## ' + richTextToMd(block.heading_2.rich_text) + '\n\n';
        break;
      case 'heading_3':
        markdown += '### ' + richTextToMd(block.heading_3.rich_text) + '\n\n';
        break;
      case 'bulleted_list_item':
        markdown += '- ' + richTextToMd(block.bulleted_list_item.rich_text) + '\n';
        break;
      case 'numbered_list_item':
        markdown += '1. ' + richTextToMd(block.numbered_list_item.rich_text) + '\n';
        break;
      case 'image': {
        const url = block.image.file?.url || block.image.external?.url || '';
        const caption = block.image.caption?.map(t => t.plain_text).join('') || '';
        markdown += `![${caption}](${url})\n\n`;
        break;
      }
      case 'divider':
        markdown += '---\n\n';
        break;
      case 'quote':
        markdown += '> ' + richTextToMd(block.quote.rich_text) + '\n\n';
        break;
      default:
        break;
    }
  }
  return markdown.trim();
}

function richTextToMd(richText) {
  if (!richText) return '';
  return richText.map(t => {
    let text = t.plain_text;
    if (t.annotations.bold) text = `**${text}**`;
    if (t.annotations.italic) text = `*${text}*`;
    if (t.annotations.code) text = '`' + text + '`';
    if (t.href) text = `[${text}](${t.href})`;
    return text;
  }).join('');
}

function generateAstroPage(post, content) {
  const title = getProperty(post, 'Title');
  const pillar = getProperty(post, 'Pillar');
  const postType = getProperty(post, 'Post Type');
  const slug = getProperty(post, 'Slug');
  const meta = getProperty(post, 'Meta Description') || '';
  const date = getProperty(post, 'Published Date');
  const rating = getProperty(post, 'Rating');
  const bestDish = getProperty(post, 'Best Dish');
  const skipThis = getProperty(post, 'Skip This');
  const priceRange = getProperty(post, 'Price Range');
  const halal = getProperty(post, 'Halal');
  const servings = getProperty(post, 'Servings');
  const prepTime = getProperty(post, 'Prep Time');
  const cookTime = getProperty(post, 'Cook Time');
  const difficulty = getProperty(post, 'Difficulty');
  const videoUrl = getProperty(post, 'Video Embed URL');
  const ingredients = getProperty(post, 'Ingredients');
  const singaporeSwaps = getProperty(post, 'Singapore Swaps');
  const restaurantAddress = getProperty(post, 'Restaurant Address');
  const restaurantMRT = getProperty(post, 'Restaurant MRT');
  const restaurantHours = getProperty(post, 'Restaurant Hours');
  const reservation = getProperty(post, 'Reservation');
  const featured = getProperty(post, 'Featured');

  const isRecipe = postType === 'Recipe';
  const isReview = postType === 'Review';
  const pillarLower = PILLAR_FOLDERS[pillar] || 'eat';
  const pillarTag = `${pillar} &middot; ${postType}`;

  // Build Quick Take / Recipe Card
  let infoCard = '';
  if (isRecipe) {
    infoCard = `
    <div class="info-card">
      <div class="info-card-header">Recipe Card</div>
      <div class="info-card-grid">
        <div><span class="info-label">Servings</span><span class="info-value">${servings || '-'}</span></div>
        <div><span class="info-label">Prep Time</span><span class="info-value">${prepTime ? prepTime + ' min' : '-'}</span></div>
        <div><span class="info-label">Cook Time</span><span class="info-value">${cookTime ? cookTime + ' min' : '-'}</span></div>
        <div><span class="info-label">Difficulty</span><span class="info-value">${difficulty || '-'}</span></div>
      </div>
    </div>`;
  } else if (isReview) {
    infoCard = `
    <div class="info-card">
      <div class="info-card-header">Quick Take</div>
      <div class="info-card-grid">
        <div><span class="info-label">Rating</span><span class="info-value rating">${rating || '-'} / 10</span></div>
        <div><span class="info-label">Price Range</span><span class="info-value">${priceRange || '-'}</span></div>
        <div><span class="info-label">Best Dish</span><span class="info-value">${bestDish || '-'}</span></div>
        <div><span class="info-label">Skip This</span><span class="info-value">${skipThis || '-'}</span></div>
      </div>
    </div>`;
  }

  // Video embed
  let videoEmbed = '';
  if (videoUrl) {
    videoEmbed = `
    <div class="article-video">
      <a href="${videoUrl}" target="_blank" rel="noopener" class="article-video-inner">
        <div class="article-video-placeholder">
          <div class="article-video-play"></div>
          <span>Watch on Instagram</span>
        </div>
      </a>
      <p class="article-video-caption">Watch the full video on Instagram @thehansang.sg</p>
    </div>`;
  }

  // Restaurant info block (reviews only)
  let restaurantInfo = '';
  if (isReview && restaurantAddress) {
    restaurantInfo = `
    <div class="restaurant-info">
      <div class="restaurant-info-header">Restaurant Info</div>
      <dl>
        ${restaurantAddress ? `<div><dt>Address</dt><dd>${restaurantAddress}</dd></div>` : ''}
        ${restaurantMRT ? `<div><dt>MRT</dt><dd>${restaurantMRT}</dd></div>` : ''}
        ${restaurantHours ? `<div><dt>Hours</dt><dd>${restaurantHours}</dd></div>` : ''}
        ${priceRange ? `<div><dt>Price Range</dt><dd>${priceRange} per person</dd></div>` : ''}
        ${reservation ? `<div><dt>Reservation</dt><dd>${reservation}</dd></div>` : ''}
        <div><dt>Halal</dt><dd>${halal ? 'Yes' : 'No'}</dd></div>
      </dl>
    </div>`;
  }

  // Verdict (reviews only)
  let verdict = '';
  if (isReview && rating) {
    verdict = `
    <div class="verdict">
      <h2>Verdict</h2>
      <div class="verdict-rating">${rating}<span class="verdict-of"> / 10</span></div>
    </div>`;
  }

  // Convert markdown content to HTML (basic)
  const htmlContent = markdownToHtml(content);

  return `---
import BaseLayout from '../../layouts/BaseLayout.astro';
---

<BaseLayout title="${title}" description="${meta}">
  <article class="article-page">
    <header class="article-header">
      <div class="article-pillar-tag">${pillarTag}</div>
      <h1>${title}</h1>
      <div class="article-byline">
        <span class="article-author">Eric Sim</span>
        <span>/</span>
        <time>${date || 'Coming Soon'}</time>
      </div>
    </header>

    ${videoEmbed}
    ${infoCard}

    <div class="article-body">
      ${htmlContent}
    </div>

    ${restaurantInfo}
    ${verdict}
  </article>
</BaseLayout>

<style>
  .article-page { max-width: 780px; margin: 0 auto; padding: 0 24px; }
  .article-header { text-align: center; padding: 48px 0 32px; border-bottom: 1px solid var(--stone); margin-bottom: 32px; }
  .article-pillar-tag { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--ember); margin-bottom: 16px; }
  .article-header h1 { font-family: 'Source Serif 4', serif; font-size: 38px; font-weight: 700; line-height: 1.2; margin-bottom: 16px; }
  .article-byline { font-size: 13px; color: var(--gray-400); display: flex; gap: 8px; justify-content: center; }
  .article-author { font-weight: 600; color: var(--ink); }

  .article-video { max-width: 400px; margin: 32px auto; }
  .article-video-inner { display: block; background: var(--stone); aspect-ratio: 9/16; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px; text-decoration: none; color: var(--gray-400); font-size: 12px; }
  .article-video-play { width: 48px; height: 48px; background: rgba(0,0,0,0.5); border-radius: 50%; display: flex; align-items: center; justify-content: center; }
  .article-video-play::after { content: ''; border-style: solid; border-width: 8px 0 8px 14px; border-color: transparent transparent transparent white; margin-left: 3px; }
  .article-video-caption { text-align: center; font-size: 12px; color: var(--gray-400); margin-top: 8px; font-style: italic; }

  .info-card { border: 1px solid var(--stone); padding: 24px; margin-bottom: 32px; }
  .info-card-header { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gray-400); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--stone); }
  .info-card-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .info-label { display: block; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--gray-400); margin-bottom: 4px; }
  .info-value { font-family: 'Source Serif 4', serif; font-size: 18px; font-weight: 600; }
  .info-value.rating { color: var(--ember); }

  .article-body { font-family: 'Source Serif 4', serif; font-size: 18px; line-height: 1.8; }
  .article-body h2 { font-size: 24px; font-weight: 700; margin: 40px 0 16px; }
  .article-body h3 { font-size: 20px; font-weight: 600; margin: 32px 0 12px; }
  .article-body p { margin-bottom: 20px; }
  .article-body ul, .article-body ol { margin-bottom: 20px; padding-left: 24px; }
  .article-body li { margin-bottom: 8px; }
  .article-body strong { font-weight: 700; }
  .article-body em { font-style: italic; }
  .article-body img { width: 100%; height: auto; margin: 24px 0; }
  .article-body hr { border: none; border-top: 1px solid var(--stone); margin: 32px 0; }

  .restaurant-info { border: 1px solid var(--stone); padding: 24px; margin: 40px 0; }
  .restaurant-info-header { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gray-400); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--stone); }
  .restaurant-info dl { display: flex; flex-direction: column; gap: 12px; }
  .restaurant-info dl > div { display: grid; grid-template-columns: 120px 1fr; gap: 16px; }
  .restaurant-info dt { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--gray-400); padding-top: 3px; }
  .restaurant-info dd { font-size: 15px; }

  .verdict { margin: 40px 0; padding-top: 32px; border-top: 1px solid var(--stone); }
  .verdict h2 { font-family: 'Source Serif 4', serif; font-size: 24px; font-weight: 700; margin-bottom: 8px; }
  .verdict-rating { font-family: 'Source Serif 4', serif; font-size: 48px; font-weight: 700; color: var(--ember); }
  .verdict-of { font-size: 20px; color: var(--gray-400); font-weight: 400; }

  @media (max-width: 768px) {
    .article-header h1 { font-size: 28px; }
    .article-body { font-size: 16px; }
    .info-card-grid { grid-template-columns: 1fr 1fr; gap: 12px; }
  }
</style>`;
}

function markdownToHtml(md) {
  let html = md;
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => '<ul>' + match + '</ul>');
  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr />');
  // Paragraphs - wrap remaining text lines
  html = html.replace(/^(?!<[hulo]|<li|<hr|<img)(.+)$/gm, '<p>$1</p>');
  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  // Photo markers
  html = html.replace(/<p>📷[^<]*<\/p>/g, '');
  return html;
}

async function main() {
  console.log('Fetching published posts from Notion...');
  const posts = await fetchPublishedPosts();
  console.log(`Found ${posts.length} published post(s).`);

  if (posts.length === 0) {
    console.log('No posts with Status = Done. Nothing to sync.');
    return;
  }

  for (const post of posts) {
    const title = getProperty(post, 'Title');
    const slug = getProperty(post, 'Slug');
    const pillar = getProperty(post, 'Pillar');

    if (!slug || !pillar) {
      console.warn(`Skipping "${title}" — missing slug or pillar.`);
      continue;
    }

    const folder = PILLAR_FOLDERS[pillar];
    if (!folder) {
      console.warn(`Skipping "${title}" — unknown pillar "${pillar}".`);
      continue;
    }

    console.log(`Syncing: ${title} → /${folder}/${slug}/`);

    const content = await getPageContent(post.id);
    const astroPage = generateAstroPage(post, content);

    const dir = path.join(PAGES_DIR, folder, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.astro'), astroPage);

    console.log(`  Written: src/pages/${folder}/${slug}/index.astro`);
  }

  console.log('Sync complete.');
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
