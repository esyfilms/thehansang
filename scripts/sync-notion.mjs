/**
 * Notion -> Astro Sync Script
 * Fetches posts from Notion Posts DB where Status = "Done" and Kill Switch = true
 * Generates:
 *   1. Individual article pages:  src/pages/{pillar}/{slug}/index.astro
 *   2. Category listing pages:    src/pages/{pillar}/index.astro
 *   3. Homepage:                  src/pages/index.astro
 */

import { Client } from '@notionhq/client';
import fs from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const POSTS_DS_ID = '54bd1d7c-c34a-4351-aa57-f0137d946f8f';
const PAGES_DIR = path.resolve('src/pages');

const DEFAULT_AUTHOR = 'Eric Youn @esyfilms';

// Pillar config: folder, Korean name, English name, description
const PILLAR_CONFIG = {
  Eat: {
    folder: 'eat',
    korean: '\uBA39\uB2E4',
    english: 'Eat',
    description: 'Restaurant reviews, KBBQ guides, and the best Korean food in Singapore.',
  },
  Cook: {
    folder: 'cook',
    korean: '\uC694\uB9AC\uD558\uB2E4',
    english: 'Cook',
    description: 'Korean recipes adapted for Singapore kitchens, with local ingredient swaps.',
  },
  Travel: {
    folder: 'travel',
    korean: '\uC5EC\uD589',
    english: 'Travel',
    description: 'Korea travel guides written for Singaporeans.',
  },
  Culture: {
    folder: 'culture',
    korean: '\uBB38\uD654',
    english: 'Culture',
    description: 'K-drama, K-pop, beauty, and language explainers.',
  },
  Events: {
    folder: 'events',
    korean: '\uD589\uC0AC',
    english: 'Events',
    description: 'Korean festivals, pop-ups, and happenings in Singapore.',
  },
};

// ---------------------------------------------------------------------------
// Notion helpers
// ---------------------------------------------------------------------------

async function fetchPublishedPosts() {
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
    case 'title':
      return prop.title.map(t => t.plain_text).join('');
    case 'rich_text':
      return prop.rich_text.map(t => t.plain_text).join('');
    case 'select':
      return prop.select?.name || null;
    case 'multi_select':
      return prop.multi_select.map(s => s.name);
    case 'number':
      return prop.number;
    case 'checkbox':
      return prop.checkbox;
    case 'url':
      return prop.url;
    case 'date':
      return prop.date?.start || null;
    case 'status':
      return prop.status?.name || null;
    case 'files':
      return prop.files.map(f => f.file?.url || f.external?.url).filter(Boolean);
    default:
      return null;
  }
}

async function getPageBlocks(pageId) {
  const blocks = [];
  let cursor;
  do {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      start_cursor: cursor,
    });
    blocks.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

// ---------------------------------------------------------------------------
// Block -> HTML conversion
// ---------------------------------------------------------------------------

function richTextToHtml(richText) {
  if (!richText || richText.length === 0) return '';
  return richText
    .map(t => {
      let text = escapeHtml(t.plain_text);
      if (t.annotations.bold) text = `<strong>${text}</strong>`;
      if (t.annotations.italic) text = `<em>${text}</em>`;
      if (t.annotations.strikethrough) text = `<s>${text}</s>`;
      if (t.annotations.underline) text = `<u>${text}</u>`;
      if (t.annotations.code) text = `<code>${text}</code>`;
      if (t.href) text = `<a href="${escapeHtml(t.href)}">${text}</a>`;
      return text;
    })
    .join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function blocksToHtml(blocks) {
  let html = '';
  let inList = null; // 'ul' | 'ol' | null

  for (const block of blocks) {
    const type = block.type;

    // Close any open list if the next block is not a matching list item
    if (inList === 'ul' && type !== 'bulleted_list_item') {
      html += '</ul>\n';
      inList = null;
    }
    if (inList === 'ol' && type !== 'numbered_list_item') {
      html += '</ol>\n';
      inList = null;
    }

    switch (type) {
      case 'paragraph':
        html += `<p>${richTextToHtml(block.paragraph.rich_text)}</p>\n`;
        break;
      case 'heading_1':
        html += `<h2>${richTextToHtml(block.heading_1.rich_text)}</h2>\n`;
        break;
      case 'heading_2':
        html += `<h2>${richTextToHtml(block.heading_2.rich_text)}</h2>\n`;
        break;
      case 'heading_3':
        html += `<h3>${richTextToHtml(block.heading_3.rich_text)}</h3>\n`;
        break;
      case 'bulleted_list_item':
        if (inList !== 'ul') {
          html += '<ul>\n';
          inList = 'ul';
        }
        html += `  <li>${richTextToHtml(block.bulleted_list_item.rich_text)}</li>\n`;
        break;
      case 'numbered_list_item':
        if (inList !== 'ol') {
          html += '<ol>\n';
          inList = 'ol';
        }
        html += `  <li>${richTextToHtml(block.numbered_list_item.rich_text)}</li>\n`;
        break;
      case 'image': {
        const url = block.image.file?.url || block.image.external?.url || '';
        const caption = block.image.caption?.map(t => t.plain_text).join('') || '';
        if (url) {
          html += `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(caption)}" loading="lazy" />${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>\n`;
        }
        break;
      }
      case 'divider':
        html += '<hr />\n';
        break;
      case 'quote':
        html += `<blockquote>${richTextToHtml(block.quote.rich_text)}</blockquote>\n`;
        break;
      case 'callout':
        html += `<div class="callout">${richTextToHtml(block.callout.rich_text)}</div>\n`;
        break;
      case 'code':
        html += `<pre><code>${escapeHtml(block.code.rich_text.map(t => t.plain_text).join(''))}</code></pre>\n`;
        break;
      case 'toggle':
        html += `<details><summary>${richTextToHtml(block.toggle.rich_text)}</summary></details>\n`;
        break;
      default:
        break;
    }
  }

  // Close trailing lists
  if (inList === 'ul') html += '</ul>\n';
  if (inList === 'ol') html += '</ol>\n';

  return html;
}

function getPlainText(blocks) {
  return blocks
    .map(b => {
      const rt =
        b[b.type]?.rich_text ||
        b[b.type]?.text ||
        [];
      return rt.map(t => t.plain_text).join('');
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// Instagram embed helper
// ---------------------------------------------------------------------------

function getIgThumbnail(url) {
  if (!url) return '';
  // Extract post ID from Instagram URL patterns:
  // https://www.instagram.com/p/ABC123/
  // https://www.instagram.com/reel/ABC123/
  const match = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (!match) return '';
  return `https://www.instagram.com/p/${match[1]}/media/?size=l`;
}

async function downloadIgThumbnail(igUrl, slug) {
  if (!igUrl || !slug) return null;
  try {
    const postId = igUrl.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/)?.[1];
    if (!postId) return null;

    const mediaUrl = `https://www.instagram.com/p/${postId}/media/?size=l`;
    const response = await fetch(mediaUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
    });

    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    const dir = path.resolve('public/images/posts');
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${slug}-thumb.jpg`);
    await writeFile(filePath, buffer);
    console.log(`  Downloaded IG thumbnail for "${slug}"`);
    return `/images/posts/${slug}-thumb.jpg`;
  } catch (e) {
    console.warn(`  Failed to download IG thumbnail for "${slug}":`, e.message);
    return null;
  }
}

function buildIgEmbed(url) {
  if (!url) return '';
  // Normalise to embed URL
  let embedUrl = url.trim().replace(/\/$/, '');
  // If it's a /reel/ URL, keep as-is (Instagram embeds work for both /p/ and /reel/)
  if (!embedUrl.endsWith('/embed')) {
    embedUrl += '/embed/';
  }
  return `
    <div class="article-video">
      <iframe src="${embedUrl}" width="400" height="480" frameborder="0" scrolling="no" allowtransparency="true" style="border:none;overflow:hidden;max-width:100%;"></iframe>
      <p class="article-video-caption">Watch the full video on Instagram @thehansang.sg</p>
    </div>`;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-SG', { year: 'numeric', month: 'long', day: 'numeric' });
}

function estimateReadTime(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

// ---------------------------------------------------------------------------
// Extract structured post data from a Notion page
// ---------------------------------------------------------------------------

async function extractPostData(page) {
  const data = {
    id: page.id,
    title: getProperty(page, 'Title') || 'Untitled',
    pillar: getProperty(page, 'Pillar'),
    postType: getProperty(page, 'Post Type'),
    slug: getProperty(page, 'Slug'),
    meta: getProperty(page, 'Meta Description') || '',
    date: getProperty(page, 'Published Date'),
    rating: getProperty(page, 'Rating'),
    bestDish: getProperty(page, 'Best Dish'),
    skipThis: getProperty(page, 'Skip This'),
    priceRange: getProperty(page, 'Price Range'),
    halal: getProperty(page, 'Halal'),
    servings: getProperty(page, 'Servings'),
    prepTime: getProperty(page, 'Prep Time'),
    cookTime: getProperty(page, 'Cook Time'),
    difficulty: getProperty(page, 'Difficulty'),
    videoUrl: getProperty(page, 'Video Embed URL'),
    ingredients: getProperty(page, 'Ingredients'),
    singaporeSwaps: getProperty(page, 'Singapore Swaps'),
    restaurantAddress: getProperty(page, 'Restaurant Address'),
    restaurantMRT: getProperty(page, 'Restaurant MRT'),
    restaurantHours: getProperty(page, 'Restaurant Hours'),
    reservation: getProperty(page, 'Reservation'),
    featured: getProperty(page, 'Featured'),
    homepagePosition: getProperty(page, 'Homepage Position'),
    contributor: getProperty(page, 'Contributor'),
    affiliateLink: getProperty(page, 'Affiliate Link'),
    coverImages: getProperty(page, 'Cover Image') || [],
  };

  // Resolve cover URL: use first cover image, fall back to downloaded IG thumbnail
  const igThumb = data.coverImages[0] ? null : await downloadIgThumbnail(data.videoUrl, data.slug);
  data.coverUrl = data.coverImages[0] || igThumb || '';

  return data;
}

// ---------------------------------------------------------------------------
// Filter pills config by pillar
// ---------------------------------------------------------------------------

const FILTER_PILLS = {
  Eat: [
    { label: 'All', filter: 'all' },
    { label: 'Reviews', filter: 'review' },
    { label: 'KBBQ', filter: 'kbbq' },
    { label: 'New Openings', filter: 'new opening' },
    { label: 'Rankings', filter: 'listicle' },
  ],
  Cook: [
    { label: 'All', filter: 'all' },
    { label: 'Mains', filter: 'main' },
    { label: 'Sides', filter: 'side' },
    { label: 'Soups & Stews', filter: 'soup' },
    { label: 'Snacks', filter: 'snack' },
    { label: 'Noodles', filter: 'noodle' },
  ],
  Travel: [
    { label: 'All', filter: 'all' },
    { label: 'Seoul', filter: 'seoul' },
    { label: 'Busan', filter: 'busan' },
    { label: 'Jeju', filter: 'jeju' },
    { label: 'Food Districts', filter: 'food district' },
  ],
  Culture: [
    { label: 'All', filter: 'all' },
    { label: 'K-Drama', filter: 'kdrama' },
    { label: 'K-Pop', filter: 'kpop' },
    { label: 'Beauty', filter: 'beauty' },
    { label: 'Language', filter: 'language' },
  ],
  Events: [
    { label: 'All', filter: 'all' },
    { label: 'Festivals', filter: 'festival' },
    { label: 'Pop-Ups', filter: 'popup' },
    { label: 'Markets', filter: 'market' },
  ],
};

// ---------------------------------------------------------------------------
// 1. Generate individual article page
// ---------------------------------------------------------------------------

function generateArticlePage(post, bodyHtml, plainText) {
  const pillarCfg = PILLAR_CONFIG[post.pillar] || PILLAR_CONFIG.Eat;
  const pillarTag = `${(post.pillar || 'Eat').toUpperCase()} &middot; ${(post.postType || 'Article').toUpperCase()}`;
  const contributor = post.contributor || DEFAULT_AUTHOR;
  const dateFormatted = formatDate(post.date);
  const readTime = estimateReadTime(plainText);
  const isRecipe = post.postType === 'Recipe';
  const isReview = post.postType === 'Review';

  // Instagram embed
  const videoEmbed = buildIgEmbed(post.videoUrl);

  // Recipe card
  let infoCard = '';
  if (isRecipe) {
    infoCard = `
    <div class="info-card">
      <div class="info-card-header">Recipe Card</div>
      <div class="info-card-grid">
        <div><span class="info-label">Servings</span><span class="info-value">${post.servings || '-'}</span></div>
        <div><span class="info-label">Prep Time</span><span class="info-value">${post.prepTime ? post.prepTime + ' min' : '-'}</span></div>
        <div><span class="info-label">Cook Time</span><span class="info-value">${post.cookTime ? post.cookTime + ' min' : '-'}</span></div>
        <div><span class="info-label">Difficulty</span><span class="info-value">${post.difficulty || '-'}</span></div>
      </div>
    </div>`;
  } else if (isReview) {
    infoCard = `
    <div class="info-card">
      <div class="info-card-header">Quick Take</div>
      <div class="info-card-grid">
        <div><span class="info-label">Rating</span><span class="info-value rating">${post.rating || '-'} / 10</span></div>
        <div><span class="info-label">Price Range</span><span class="info-value">${post.priceRange || '-'}</span></div>
        <div><span class="info-label">Best Dish</span><span class="info-value">${post.bestDish || '-'}</span></div>
        <div><span class="info-label">Skip This</span><span class="info-value">${post.skipThis || '-'}</span></div>
      </div>
    </div>`;
  }

  // Singapore Swaps
  let sgSwapBlock = '';
  if (post.singaporeSwaps) {
    sgSwapBlock = `
    <div class="sg-swap-box">
      <div class="sg-swap-header">Singapore Swap</div>
      <p>${escapeHtml(post.singaporeSwaps)}</p>
    </div>`;
  }

  // Affiliate link (ONLY if present)
  let affiliateBlock = '';
  if (post.affiliateLink) {
    affiliateBlock = `
    <div class="affiliate-link">
      <a href="${escapeHtml(post.affiliateLink)}" target="_blank" rel="noopener sponsored">Shop the ingredients &rarr;</a>
    </div>`;
  }

  // Restaurant info (reviews only)
  let restaurantInfo = '';
  if (isReview && post.restaurantAddress) {
    restaurantInfo = `
    <div class="restaurant-info">
      <div class="restaurant-info-header">Restaurant Info</div>
      <dl>
        ${post.restaurantAddress ? `<div><dt>Address</dt><dd>${escapeHtml(post.restaurantAddress)}</dd></div>` : ''}
        ${post.restaurantMRT ? `<div><dt>MRT</dt><dd>${escapeHtml(post.restaurantMRT)}</dd></div>` : ''}
        ${post.restaurantHours ? `<div><dt>Hours</dt><dd>${escapeHtml(post.restaurantHours)}</dd></div>` : ''}
        ${post.priceRange ? `<div><dt>Price Range</dt><dd>${escapeHtml(post.priceRange)} per person</dd></div>` : ''}
        ${post.reservation ? `<div><dt>Reservation</dt><dd>${escapeHtml(post.reservation)}</dd></div>` : ''}
        <div><dt>Halal</dt><dd>${post.halal ? 'Yes' : 'No'}</dd></div>
      </dl>
    </div>`;
  }

  // Verdict (reviews with rating)
  let verdict = '';
  if (isReview && post.rating) {
    verdict = `
    <div class="verdict">
      <h2>Verdict</h2>
      <div class="verdict-rating">${post.rating}<span class="verdict-of"> / 10</span></div>
    </div>`;
  }

  return `---
import BaseLayout from '../../../layouts/BaseLayout.astro';
---

<BaseLayout title="${escapeHtml(post.title)}" description="${escapeHtml(post.meta)}">
  <article class="article-page">
    ${post.coverUrl ? `<div class="article-hero" style="max-width: 900px; margin: 0 auto; aspect-ratio: 16/9; background: var(--linen) url('${escapeHtml(post.coverUrl)}') center/cover no-repeat;"></div>` : ''}

    <header class="article-header">
      <div class="article-pillar-tag">${pillarTag}</div>
      <h1>${escapeHtml(post.title)}</h1>
      <div class="article-meta">
        <span class="article-contributor">${escapeHtml(contributor)}</span>
        <span class="article-meta-sep">/</span>
        <time datetime="${post.date || ''}">${dateFormatted || 'Coming Soon'}</time>
        <span class="article-meta-sep">/</span>
        <span class="article-read-time">${readTime} min read</span>
      </div>
    </header>

    <div class="article-share">
      <span class="article-share-label">Share</span>
      <a href="#" class="share-link" data-share="copy" title="Copy link">Copy Link</a>
      <span class="share-dot">&middot;</span>
      <a href="https://twitter.com/intent/tweet?url=ARTICLE_URL&text=${encodeURIComponent(post.title)}" class="share-link" target="_blank" rel="noopener" title="Share on X">X</a>
      <span class="share-dot">&middot;</span>
      <a href="https://www.facebook.com/sharer/sharer.php?u=ARTICLE_URL" class="share-link" target="_blank" rel="noopener" title="Share on Facebook">Facebook</a>
      <span class="share-dot">&middot;</span>
      <a href="https://wa.me/?text=${encodeURIComponent(post.title)}%20ARTICLE_URL" class="share-link" target="_blank" rel="noopener" title="Share on WhatsApp">WhatsApp</a>
      <span class="copy-toast" id="copyToast">Link copied!</span>
    </div>

    ${videoEmbed}
    ${infoCard}

    <div class="article-body">
      ${bodyHtml}
    </div>

    ${sgSwapBlock}
    ${affiliateBlock}
    ${restaurantInfo}
    ${verdict}
  </article>

<script>
  // Replace ARTICLE_URL placeholders with actual page URL
  document.querySelectorAll('.share-link').forEach(link => {
    if (link.href) link.href = link.href.replace(/ARTICLE_URL/g, encodeURIComponent(window.location.href));
  });
  // Copy link handler with toast
  document.querySelector('[data-share="copy"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    navigator.clipboard.writeText(window.location.href).then(() => {
      const toast = document.getElementById('copyToast');
      if (toast) {
        toast.classList.add('show');
        setTimeout(() => { toast.classList.remove('show'); }, 2000);
      }
    });
  });
</script>
</BaseLayout>

<style>
  .article-page {
    max-width: 780px;
    margin: 0 auto;
    padding: 0 24px;
  }

  /* ---- Header: CENTER-ALIGNED ---- */
  .article-header {
    text-align: center;
    max-width: 720px;
    margin: 0 auto;
    padding: 48px 24px 32px;
    border-bottom: 1px solid var(--stone);
    margin-bottom: 32px;
  }
  .article-pillar-tag {
    font-size: 11px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ember);
    margin-bottom: 16px;
    font-family: 'Outfit', sans-serif;
    text-align: center;
  }
  .article-header h1 {
    font-family: 'Source Serif 4', serif;
    font-size: 38px;
    font-weight: 700;
    line-height: 1.2;
    margin-bottom: 16px;
    color: var(--ink);
    text-align: center;
    text-wrap: balance;
    max-width: 660px;
    margin-left: auto;
    margin-right: auto;
  }
  .article-meta {
    font-size: 13px;
    color: var(--gray-400, #999);
    display: flex;
    gap: 8px;
    align-items: center;
    text-align: center;
    justify-content: center;
  }
  .article-contributor {
    font-weight: 600;
    color: var(--ink);
  }
  .article-meta-sep {
    color: var(--stone);
  }
  .article-read-time {
    color: var(--gray-400, #999);
  }

  /* ---- Instagram embed ---- */
  .article-video {
    text-align: center;
    max-width: 500px;
    margin: 32px auto;
  }
  .article-video iframe {
    display: block;
    margin: 0 auto;
    max-width: 100%;
  }
  .article-video-caption {
    font-size: 12px;
    color: var(--gray-400, #999);
    margin-top: 8px;
    font-style: italic;
  }

  /* ---- Info card (Recipe Card / Quick Take) ---- */
  .info-card {
    border: 1px solid var(--stone);
    padding: 24px;
    margin-bottom: 32px;
  }
  .info-card-header {
    font-size: 11px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--gray-400, #999);
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--stone);
    font-family: 'Outfit', sans-serif;
  }
  .info-card-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .info-label {
    display: block;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--gray-400, #999);
    margin-bottom: 4px;
    font-family: 'Outfit', sans-serif;
  }
  .info-value {
    font-family: 'Source Serif 4', serif;
    font-size: 18px;
    font-weight: 600;
  }
  .info-value.rating {
    color: var(--ember);
  }

  /* ---- Body ---- */
  .article-body {
    font-family: 'Source Serif 4', serif;
    font-size: 18px;
    line-height: 1.8;
    text-align: left;
    -webkit-hyphens: auto;
    hyphens: auto;
    color: var(--ink);
    max-width: 660px;
    margin: 0 auto;
  }
  .article-body h2 {
    font-size: 24px;
    font-weight: 700;
    margin: 40px 0 16px;
  }
  .article-body h3 {
    font-size: 20px;
    font-weight: 600;
    margin: 32px 0 12px;
  }
  .article-body p {
    margin-bottom: 20px;
  }
  .article-body ul,
  .article-body ol {
    margin-bottom: 20px;
    padding-left: 24px;
  }
  .article-body li {
    margin-bottom: 8px;
  }
  .article-body strong {
    font-weight: 700;
  }
  .article-body em {
    font-style: italic;
  }
  .article-body figure {
    margin: 24px 0;
  }
  .article-body img {
    width: 100%;
    height: auto;
    display: block;
  }
  .article-body figcaption {
    font-size: 13px;
    color: var(--gray-400, #999);
    margin-top: 8px;
    font-family: 'Outfit', sans-serif;
  }
  .article-body hr {
    border: none;
    border-top: 1px solid var(--stone);
    margin: 32px 0;
  }
  .article-body blockquote {
    border-left: 3px solid var(--ember);
    padding-left: 20px;
    margin: 24px 0;
    font-style: italic;
    color: var(--gray-400, #999);
  }
  .article-body .callout {
    background: var(--linen, #EDE6DC);
    padding: 16px 20px;
    margin: 24px 0;
    border-left: 3px solid var(--ember);
    font-size: 16px;
  }

  /* ---- Singapore Swap box ---- */
  .sg-swap-box {
    background: var(--linen, #EDE6DC);
    border: 1px solid var(--stone);
    padding: 24px;
    margin: 32px 0;
  }
  .sg-swap-header {
    font-size: 11px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ember);
    margin-bottom: 12px;
    font-family: 'Outfit', sans-serif;
    font-weight: 600;
  }
  .sg-swap-box p {
    font-family: 'Source Serif 4', serif;
    font-size: 16px;
    line-height: 1.7;
    margin: 0;
  }

  /* ---- Affiliate link ---- */
  .affiliate-link {
    margin: 32px 0;
    text-align: center;
  }
  .affiliate-link a {
    display: inline-block;
    padding: 12px 32px;
    background: var(--ember);
    color: #fff;
    font-family: 'Outfit', sans-serif;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-decoration: none;
    text-transform: uppercase;
    transition: opacity 0.2s;
  }
  .affiliate-link a:hover {
    opacity: 0.85;
  }

  /* ---- Restaurant info ---- */
  .restaurant-info {
    border: 1px solid var(--stone);
    padding: 24px;
    margin: 40px 0;
  }
  .restaurant-info-header {
    font-size: 11px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--gray-400, #999);
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--stone);
    font-family: 'Outfit', sans-serif;
  }
  .restaurant-info dl {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .restaurant-info dl > div {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 16px;
  }
  .restaurant-info dt {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--gray-400, #999);
    padding-top: 3px;
    font-family: 'Outfit', sans-serif;
  }
  .restaurant-info dd {
    font-size: 15px;
  }

  /* ---- Verdict ---- */
  .verdict {
    margin: 40px 0;
    padding-top: 32px;
    border-top: 1px solid var(--stone);
  }
  .verdict h2 {
    font-family: 'Source Serif 4', serif;
    font-size: 24px;
    font-weight: 700;
    margin-bottom: 8px;
  }
  .verdict-rating {
    font-family: 'Source Serif 4', serif;
    font-size: 48px;
    font-weight: 700;
    color: var(--ember);
  }
  .verdict-of {
    font-size: 20px;
    color: var(--gray-400, #999);
    font-weight: 400;
  }

  /* ---- Share section (top, below header) ---- */
  .article-share {
    position: relative;
    max-width: 660px;
    margin: 0 auto 32px;
    padding-bottom: 24px;
    border-bottom: 1px solid var(--stone);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    font-family: 'Outfit', sans-serif;
    font-size: 13px;
  }
  .article-share-label {
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--gray-400, #999);
    margin-right: 4px;
  }
  .share-link {
    color: var(--ink);
    text-decoration: none;
    cursor: pointer;
    transition: color 0.15s;
  }
  .share-link:hover {
    color: var(--ember);
  }
  .share-dot {
    color: var(--stone);
  }
  .copy-toast {
    position: absolute;
    top: -36px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--ink);
    color: var(--cream);
    padding: 6px 16px;
    border-radius: 4px;
    font-size: 12px;
    letter-spacing: 0.05em;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
  }
  .copy-toast.show {
    opacity: 1;
  }

  @media (max-width: 768px) {
    .article-header h1 {
      font-size: 28px;
    }
    .article-body {
      font-size: 16px;
    }
    .info-card-grid {
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .article-video {
      max-width: 100%;
    }
  }
</style>`;
}

// ---------------------------------------------------------------------------
// 2. Generate category listing page
// ---------------------------------------------------------------------------

function generateCategoryPage(pillar, posts) {
  const cfg = PILLAR_CONFIG[pillar];
  if (!cfg) return null;

  const categoryFeatured = posts.filter(p => p.homepagePosition === 'Category Featured');
  const gridPosts = posts.filter(p => p.homepagePosition !== 'Category Featured');

  // Build featured card(s) -- carousel if multiple
  let featuredSection = '';
  if (categoryFeatured.length === 1) {
    const f = categoryFeatured[0];
    featuredSection = `
    <section class="category-featured">
      <a href="/${cfg.folder}/${f.slug}/" class="featured-card">
        <div class="featured-card-image"${f.coverUrl ? ` style="background-image:url('${escapeHtml(f.coverUrl)}');background-size:cover;background-position:center;"` : ''}></div>
        <div class="featured-card-content">
          <div class="featured-card-tag">${(f.pillar || '').toUpperCase()} &middot; ${(f.postType || '').toUpperCase()}</div>
          <h2>${escapeHtml(f.title)}</h2>
          <p>${escapeHtml((f.excerpt || '').slice(0, 150))}${(f.excerpt || '').length > 150 ? '...' : ''}</p>
          <time datetime="${f.date || ''}">${formatDate(f.date)}</time>
        </div>
      </a>
    </section>`;
  } else if (categoryFeatured.length > 1) {
    const items = categoryFeatured
      .map(
        f => `
        <div class="carousel-item">
          <a href="/${cfg.folder}/${f.slug}/" class="featured-card">
            <div class="featured-card-image"${f.coverUrl ? ` style="background-image:url('${escapeHtml(f.coverUrl)}');background-size:cover;background-position:center;"` : ''}></div>
            <div class="featured-card-content">
              <div class="featured-card-tag">${(f.pillar || '').toUpperCase()} &middot; ${(f.postType || '').toUpperCase()}</div>
              <h2>${escapeHtml(f.title)}</h2>
              <p>${escapeHtml((f.excerpt || '').slice(0, 150))}${(f.excerpt || '').length > 150 ? '...' : ''}</p>
              <time datetime="${f.date || ''}">${formatDate(f.date)}</time>
            </div>
          </a>
        </div>`
      )
      .join('\n');
    featuredSection = `
    <section class="category-featured auto-carousel">
      ${items}
    </section>`;
  }

  // Build article grid
  let gridSection = '';
  if (gridPosts.length > 0) {
    const cards = gridPosts
      .map(
        p => `
        <a href="/${cfg.folder}/${p.slug}/" class="grid-card article-card" data-type="${(p.postType || '').toLowerCase()}">
          <div class="grid-card-image"${p.coverUrl ? ` style="background-image:url('${escapeHtml(p.coverUrl)}');background-size:cover;background-position:center;"` : ''}></div>
          <div class="grid-card-body">
            <div class="grid-card-tag">${(p.pillar || '').toUpperCase()} &middot; ${(p.postType || '').toUpperCase()}</div>
            <h3>${escapeHtml(p.title)}</h3>
            <p>${escapeHtml((p.excerpt || '').slice(0, 150))}${(p.excerpt || '').length > 150 ? '...' : ''}</p>
            <time datetime="${p.date || ''}">${formatDate(p.date)}</time>
          </div>
        </a>`
      )
      .join('\n');
    gridSection = `
    <section class="article-grid">
      ${cards}
    </section>`;
  } else if (categoryFeatured.length === 0) {
    gridSection = `
    <section class="empty-state">
      <p>Articles coming soon.</p>
    </section>`;
  }

  return `---
import BaseLayout from '../../layouts/BaseLayout.astro';
---

<BaseLayout title="${cfg.english} - The Hansang" description="${cfg.description}">
  <div class="category-page">
    <header class="category-header">
      <span class="category-korean">${cfg.korean}</span>
      <h1>${cfg.english}</h1>
      <p class="category-desc">${cfg.description}</p>
    </header>

    <div class="filter-bar">
      ${(FILTER_PILLS[pillar] || [{ label: 'All', filter: 'all' }]).map((pill, i) => `<button class="filter-pill${i === 0 ? ' active' : ''}" data-filter="${pill.filter}">${pill.label}</button>`).join('\n      ')}
    </div>

    ${featuredSection}
    ${gridSection}
  </div>
</BaseLayout>

${CAROUSEL_SCRIPT}

<script>
  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const filter = pill.dataset.filter;
      document.querySelectorAll('.article-card').forEach(card => {
        if (filter === 'all' || card.dataset.type === filter) {
          card.style.display = '';
        } else {
          card.style.display = 'none';
        }
      });
    });
  });
</script>

<style>
  .category-page {
    max-width: 1080px;
    margin: 0 auto;
    padding: 0 24px;
  }
  .category-header {
    text-align: center;
    padding: 48px 48px 32px;
    max-width: 100%;
    margin: 0 auto;
    border-bottom: 1px solid var(--stone);
    margin-bottom: 40px;
  }
  .category-korean {
    display: block;
    font-family: 'Noto Serif KR', serif;
    font-size: 14px;
    color: var(--ember);
    letter-spacing: 0;
    margin-bottom: 8px;
    text-align: center;
  }
  .category-header h1 {
    font-family: 'Source Serif 4', serif;
    font-size: 42px;
    font-weight: 700;
    margin-bottom: 12px;
    color: var(--ink);
    text-align: center;
  }
  .category-desc {
    font-family: 'Outfit', sans-serif;
    font-size: 15px;
    color: var(--gray-400, #999);
    max-width: 480px;
    margin: 0 auto;
    text-align: center;
  }

  /* ---- Filter pills ---- */
  .filter-bar {
    display: flex;
    gap: 8px;
    padding: 16px 0 32px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .filter-pill {
    padding: 8px 20px;
    border: 1px solid var(--stone);
    border-radius: 999px;
    background: none;
    font-family: 'Outfit', sans-serif;
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    cursor: pointer;
    transition: all 0.15s;
    color: var(--ink);
  }
  .filter-pill:hover {
    border-color: var(--ink);
  }
  .filter-pill.active {
    background: var(--ink);
    color: var(--cream);
    border-color: var(--ink);
  }

  /* ---- Featured ---- */
  .category-featured {
    margin-bottom: 48px;
  }
  .featured-card {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 32px;
    text-decoration: none;
    color: inherit;
  }
  .featured-card-image {
    background: var(--stone);
    aspect-ratio: 3/2;
  }
  .featured-card-content {
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .featured-card-tag {
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ember);
    margin-bottom: 12px;
    font-family: 'Outfit', sans-serif;
  }
  .featured-card-content h2 {
    font-family: 'Source Serif 4', serif;
    font-size: 28px;
    font-weight: 700;
    line-height: 1.25;
    margin-bottom: 12px;
  }
  .featured-card-content p {
    font-size: 14px;
    color: var(--gray-400, #999);
    line-height: 1.6;
    margin-bottom: 12px;
  }
  .featured-card-content time {
    font-size: 12px;
    color: var(--gray-400, #999);
    font-family: 'Outfit', sans-serif;
  }

  /* ---- Article grid ---- */
  .article-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 32px;
    margin-bottom: 64px;
  }
  .grid-card {
    text-decoration: none;
    color: inherit;
    display: block;
  }
  .grid-card-image {
    background: var(--stone);
    aspect-ratio: 3/2;
    margin-bottom: 16px;
  }
  .grid-card-tag {
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ember);
    margin-bottom: 8px;
    font-family: 'Outfit', sans-serif;
  }
  .grid-card-body h3 {
    font-family: 'Source Serif 4', serif;
    font-size: 20px;
    font-weight: 700;
    line-height: 1.3;
    margin-bottom: 8px;
    color: var(--ink);
  }
  .grid-card-body p {
    font-size: 14px;
    color: var(--gray-400, #999);
    line-height: 1.6;
    margin-bottom: 8px;
  }
  .grid-card-body time {
    font-size: 12px;
    color: var(--gray-400, #999);
    font-family: 'Outfit', sans-serif;
  }

  .empty-state {
    text-align: center;
    padding: 64px 0;
    color: var(--gray-400, #999);
    font-family: 'Outfit', sans-serif;
    font-size: 15px;
  }

  .carousel-item {
    display: none;
  }
  .carousel-item:first-child {
    display: block;
  }

  @media (max-width: 768px) {
    .category-header h1 {
      font-size: 32px;
    }
    .featured-card {
      grid-template-columns: 1fr;
    }
    .article-grid {
      grid-template-columns: 1fr;
      gap: 24px;
    }
  }
</style>`;
}

// ---------------------------------------------------------------------------
// 3. Generate homepage
// ---------------------------------------------------------------------------

function generateHomepage(allPosts) {
  // ---------------------------------------------------------------------------
  // Categorise posts by homepage position
  // ---------------------------------------------------------------------------
  const heroPosts = allPosts.filter(p => p.homepagePosition === 'Hero');

  const koreanEatsPosts = (() => {
    const tagged = allPosts.filter(p => p.homepagePosition === 'Korean Eats');
    if (tagged.length > 0) return tagged.slice(0, 6);
    return allPosts.filter(p => p.pillar === 'Eat').slice(0, 6);
  })();

  const kitchenPosts = (() => {
    const tagged = allPosts.filter(p => p.homepagePosition === 'From the Kitchen');
    if (tagged.length > 0) return tagged.slice(0, 4);
    return allPosts.filter(p => p.pillar === 'Cook').slice(0, 4);
  })();

  const editorsPick = allPosts.find(p => p.homepagePosition === 'Editors Pick') || null;
  const videoPosts = allPosts.filter(p => p.videoUrl).slice(0, 6);

  // ---------------------------------------------------------------------------
  // 1. HERO section
  // ---------------------------------------------------------------------------
  let heroSection = '';
  const buildHeroCard = (h) => {
    const folder = PILLAR_CONFIG[h.pillar]?.folder || 'eat';
    const readTime = estimateReadTime(h.plainText || h.excerpt || '');
    const heroLabel = `FEATURED &middot; ${(h.pillar || '').toUpperCase()} &middot; ${(h.postType || '').toUpperCase()}`;
    const heroDate = formatDate(h.date);
    const heroMeta = `${heroDate}${heroDate && readTime ? ' &middot; ' : ''}${readTime} min read`;
    return `
    <section class="hero">
      <a href="/${folder}/${h.slug}/" class="hero-inner">
        <div class="hero-text">
          <div class="hero-label">${heroLabel}</div>
          <h2>${escapeHtml(h.title)}</h2>
          <p class="hero-excerpt">${escapeHtml((h.excerpt || '').slice(0, 200))}</p>
          <div class="hero-meta">${heroMeta}</div>
        </div>
        <div class="hero-image"${h.coverUrl ? ` style="background-image:url('${escapeHtml(h.coverUrl)}');background-size:cover;background-position:center;"` : ''}></div>
      </a>
    </section>`;
  };

  if (heroPosts.length >= 1) {
    heroSection = buildHeroCard(heroPosts[0]);
  } else {
    // No hero posts — show a minimal welcome
    heroSection = `
    <section class="hero">
      <div class="hero-inner" style="pointer-events:none;">
        <div class="hero-text">
          <div class="hero-label">THE HANSANG</div>
          <h2>Everything Korea, for Singapore.</h2>
          <p class="hero-excerpt">Restaurant reviews, recipes, travel guides, and culture explainers. Welcome to the table.</p>
          <div class="hero-meta"></div>
        </div>
        <div class="hero-image"></div>
      </div>
    </section>`;
  }

  // ---------------------------------------------------------------------------
  // 2. KOREAN EATS section
  // ---------------------------------------------------------------------------
  let koreanEatsSection = '';
  if (koreanEatsPosts.length > 0) {
    const cards = koreanEatsPosts
      .map((p, i) => {
        const folder = PILLAR_CONFIG[p.pillar]?.folder || 'eat';
        const cls = i === 0 ? 'eat-card eat-card--first' : 'eat-card';
        return `
          <a href="/${folder}/${p.slug}/" class="${cls}">
            <div class="eat-card-image"${p.coverUrl ? ` style="background-image:url('${escapeHtml(p.coverUrl)}');background-size:cover;background-position:center;"` : ''}></div>
            <div class="eat-card-body">
              <div class="eat-card-tag">${(p.pillar || 'EAT').toUpperCase()} &middot; ${(p.postType || '').toUpperCase()}</div>
              <h3>${escapeHtml(p.title)}</h3>
              <p class="eat-card-excerpt">${escapeHtml((p.excerpt || '').slice(0, 120))}</p>
              <time datetime="${p.date || ''}">${formatDate(p.date)}</time>
            </div>
          </a>`;
      })
      .join('\n');
    koreanEatsSection = `
    <section class="hp-section">
      <div class="hp-section-inner">
        <div class="section-header">
          <div class="section-label">KOREAN EATS</div>
          <a href="/eat/" class="section-view-all">View All</a>
        </div>
        <div class="eat-scroll-row">
          ${cards}
        </div>
      </div>
    </section>`;
  } else {
    koreanEatsSection = `
    <section class="hp-section">
      <div class="hp-section-inner">
        <div class="section-header">
          <div class="section-label">KOREAN EATS</div>
          <a href="/eat/" class="section-view-all">View All</a>
        </div>
        <p class="coming-soon">Coming soon.</p>
      </div>
    </section>`;
  }

  // ---------------------------------------------------------------------------
  // 3. FROM THE KITCHEN (dark band)
  // ---------------------------------------------------------------------------
  let kitchenSection = '';
  if (kitchenPosts.length > 0) {
    const cards = kitchenPosts
      .map(p => {
        const folder = PILLAR_CONFIG[p.pillar]?.folder || 'cook';
        return `
          <a href="/${folder}/${p.slug}/" class="kitchen-card">
            <div class="kitchen-card-image"${p.coverUrl ? ` style="background-image:url('${escapeHtml(p.coverUrl)}');background-size:cover;background-position:center;"` : ''}></div>
            <h3>${escapeHtml(p.title)}</h3>
            <time datetime="${p.date || ''}">${formatDate(p.date)}</time>
          </a>`;
      })
      .join('\n');
    kitchenSection = `
    <section class="kitchen-band">
      <div class="kitchen-inner">
        <div class="section-header-dark">
          <span class="section-korean">\uC694\uB9AC\uD558\uB2E4</span>
          <h2 class="section-title-dark">From the Kitchen</h2>
        </div>
        <div class="kitchen-scroll-row">
          ${cards}
        </div>
      </div>
    </section>`;
  } else {
    kitchenSection = `
    <section class="kitchen-band">
      <div class="kitchen-inner">
        <div class="section-header-dark">
          <span class="section-korean">\uC694\uB9AC\uD558\uB2E4</span>
          <h2 class="section-title-dark">From the Kitchen</h2>
        </div>
        <p class="coming-soon coming-soon--light">Coming soon.</p>
      </div>
    </section>`;
  }

  // ---------------------------------------------------------------------------
  // 4. EDITOR'S PICK (full-width banner, hidden if none)
  // ---------------------------------------------------------------------------
  let editorsPickSection = '';
  if (editorsPick) {
    const folder = PILLAR_CONFIG[editorsPick.pillar]?.folder || 'eat';
    editorsPickSection = `
    <section class="hp-section editors-pick-section">
      <div class="hp-section-inner">
        <div class="section-header">
          <div class="section-label">EDITOR'S PICK</div>
        </div>
        <a href="/${folder}/${editorsPick.slug}/" class="editors-pick-card">
          <div class="editors-pick-image"${editorsPick.coverUrl ? ` style="background-image:url('${escapeHtml(editorsPick.coverUrl)}');background-size:cover;background-position:center;"` : ''}></div>
          <div class="editors-pick-content">
            <div class="editors-pick-tag">${(editorsPick.pillar || '').toUpperCase()} &middot; ${(editorsPick.postType || '').toUpperCase()}</div>
            <h2>${escapeHtml(editorsPick.title)}</h2>
            <p>${escapeHtml((editorsPick.excerpt || '').slice(0, 200))}</p>
            <time datetime="${editorsPick.date || ''}">${formatDate(editorsPick.date)}</time>
          </div>
        </a>
      </div>
    </section>`;
  }
  // If no editor's pick, section is completely omitted

  // ---------------------------------------------------------------------------
  // 5. ON VIDEO
  // ---------------------------------------------------------------------------
  let videoSection = '';
  if (videoPosts.length > 0) {
    const cards = videoPosts
      .map(p => {
        const folder = PILLAR_CONFIG[p.pillar]?.folder || 'eat';
        return `
          <a href="/${folder}/${p.slug}/" class="video-card">
            <div class="video-card-thumb"${p.coverUrl ? ` style="background-image:url('${escapeHtml(p.coverUrl)}');background-size:cover;background-position:center;"` : ''}>
              <div class="video-card-play">
                <svg width="18" height="20" viewBox="0 0 18 20" fill="none"><polygon points="0,0 18,10 0,20" fill="white"/></svg>
              </div>
            </div>
            <h3>${escapeHtml(p.title)}</h3>
          </a>`;
      })
      .join('\n');
    videoSection = `
    <section class="hp-section">
      <div class="hp-section-inner">
        <div class="section-header">
          <div class="section-label">ON VIDEO</div>
          <a href="https://www.instagram.com/thehansang.sg/" target="_blank" rel="noopener" class="section-view-all">More Videos</a>
        </div>
        <div class="video-scroll-row">
          ${cards}
        </div>
      </div>
    </section>`;
  } else {
    videoSection = `
    <section class="hp-section">
      <div class="hp-section-inner">
        <div class="section-header">
          <div class="section-label">ON VIDEO</div>
          <a href="https://www.instagram.com/thehansang.sg/" target="_blank" rel="noopener" class="section-view-all">More Videos</a>
        </div>
        <p class="coming-soon">Coming soon.</p>
      </div>
    </section>`;
  }

  // ---------------------------------------------------------------------------
  // Assemble page
  // ---------------------------------------------------------------------------
  return `---
import BaseLayout from '../layouts/BaseLayout.astro';
---

<BaseLayout title="The Hansang - Everything Korea, for Singapore" description="The definitive Korean food, culture and lifestyle authority in Singapore.">
  <div class="homepage">
    ${heroSection}
    ${koreanEatsSection}
    ${kitchenSection}
    ${editorsPickSection}
    ${videoSection}
  </div>
</BaseLayout>

${CAROUSEL_SCRIPT}

<style>
  /* ===========================================================================
     Homepage master styles
     =========================================================================== */
  .homepage {
    width: 100%;
  }

  /* ---- Shared section wrapper ---- */
  .hp-section {
    padding: 64px 0;
  }
  .hp-section-inner {
    max-width: 1080px;
    margin: 0 auto;
    padding: 0 24px;
  }

  /* ---- Section headers ---- */
  .section-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 32px;
  }
  .section-label {
    font-family: 'Outfit', sans-serif;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ink, #1C1714);
  }
  .section-header-dark {
    display: flex;
    align-items: baseline;
    gap: 24px;
    border-bottom: 1px solid rgba(255,255,255,0.15);
    padding-bottom: 16px;
    margin-bottom: 32px;
  }
  .section-korean {
    font-family: 'Noto Serif KR', serif;
    font-size: 12px;
    color: var(--ember);
    letter-spacing: 0.2em;
  }
  .section-title-dark {
    font-family: 'Source Serif 4', serif;
    font-size: 28px;
    font-weight: 700;
    font-style: italic;
    color: var(--cream, #F7F3ED);
    margin: 0;
  }
  .section-view-all {
    font-family: 'Outfit', sans-serif;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ember, #B8432A);
    text-decoration: none;
  }
  .section-view-all:hover {
    text-decoration: underline;
  }

  .coming-soon {
    font-family: 'Outfit', sans-serif;
    font-size: 14px;
    color: var(--gray-400, #999);
    font-style: italic;
  }
  .coming-soon--light {
    color: rgba(247, 243, 237, 0.5);
  }

  /* ===========================================================================
     1. HERO
     =========================================================================== */
  .hero { padding: 0 48px; border-bottom: 1px solid var(--stone); }
  .hero-inner { display: grid; grid-template-columns: 5fr 7fr; min-height: 540px; text-decoration: none; color: inherit; }
  .hero-text { display: flex; flex-direction: column; justify-content: center; padding: 60px 48px 60px 0; border-right: 1px solid var(--stone); }
  .hero-label { font-family: 'Outfit', sans-serif; font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--ember); margin-bottom: 16px; }
  .hero-inner h2 { font-family: 'Source Serif 4', serif; font-size: 36px; font-weight: 700; line-height: 1.15; margin-bottom: 16px; color: var(--ink); }
  .hero-excerpt { font-family: 'Outfit', sans-serif; font-size: 15px; color: var(--gray-400, #999); line-height: 1.6; margin-bottom: 20px; }
  .hero-meta { font-family: 'Outfit', sans-serif; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--gray-400, #999); }
  .hero-image { background: var(--stone); display: flex; align-items: center; justify-content: center; min-height: 440px; overflow: hidden; background-size: cover; background-position: center; }

  /* ===========================================================================
     2. KOREAN EATS
     =========================================================================== */
  .eat-scroll-row {
    display: flex;
    gap: 24px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding-bottom: 8px;
  }
  .eat-scroll-row::-webkit-scrollbar { display: none; }

  .eat-card {
    flex: 0 0 320px;
    scroll-snap-align: start;
    text-decoration: none;
    color: inherit;
    display: flex;
    flex-direction: column;
  }
  .eat-card--first {
    flex: 0 0 400px;
  }
  .eat-card-image {
    background: var(--stone, #E0D8CE);
    aspect-ratio: 3/2;
    margin-bottom: 14px;
    border-radius: 2px;
  }
  .eat-card-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .eat-card-tag {
    font-family: 'Outfit', sans-serif;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ember, #B8432A);
    margin-bottom: 4px;
  }
  .eat-card h3 {
    font-family: 'Source Serif 4', serif;
    font-size: 18px;
    font-weight: 700;
    line-height: 1.3;
    margin-bottom: 4px;
    color: var(--ink, #1C1714);
  }
  .eat-card-excerpt {
    font-family: 'Outfit', sans-serif;
    font-size: 13px;
    color: var(--gray-400, #888);
    line-height: 1.5;
    margin-bottom: 6px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .eat-card time {
    font-family: 'Outfit', sans-serif;
    font-size: 12px;
    color: var(--gray-400, #999);
  }

  /* ===========================================================================
     3. FROM THE KITCHEN (dark band)
     =========================================================================== */
  .kitchen-band {
    background: var(--ink, #1C1714);
    color: var(--cream, #F7F3ED);
    padding: 64px 0;
  }
  .kitchen-inner {
    max-width: 1080px;
    margin: 0 auto;
    padding: 0 24px;
  }
  .kitchen-scroll-row {
    display: flex;
    gap: 24px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding-bottom: 8px;
  }
  .kitchen-scroll-row::-webkit-scrollbar { display: none; }

  .kitchen-card {
    flex: 0 0 240px;
    scroll-snap-align: start;
    text-decoration: none;
    color: var(--cream, #F7F3ED);
  }
  .kitchen-card-image {
    background: rgba(255,255,255,0.08);
    aspect-ratio: 1/1;
    margin-bottom: 14px;
    border-radius: 2px;
  }
  .kitchen-card h3 {
    font-family: 'Source Serif 4', serif;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.35;
    margin-bottom: 6px;
  }
  .kitchen-card time {
    font-family: 'Outfit', sans-serif;
    font-size: 12px;
    color: rgba(247, 243, 237, 0.5);
  }

  /* ===========================================================================
     4. EDITOR'S PICK
     =========================================================================== */
  .editors-pick-section {
    border-top: 1px solid var(--stone, #E0D8CE);
  }
  .editors-pick-card {
    display: grid;
    grid-template-columns: 1.3fr 1fr;
    gap: 48px;
    text-decoration: none;
    color: inherit;
    align-items: center;
  }
  .editors-pick-image {
    background: var(--stone, #E0D8CE);
    aspect-ratio: 16/9;
    border-radius: 2px;
  }
  .editors-pick-content {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
  }
  .editors-pick-tag {
    font-family: 'Outfit', sans-serif;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ember, #B8432A);
    margin-bottom: 8px;
  }
  .editors-pick-content h2 {
    font-family: 'Source Serif 4', serif;
    font-size: 32px;
    font-weight: 700;
    line-height: 1.22;
    margin-bottom: 16px;
    color: var(--ink, #1C1714);
  }
  .editors-pick-content p {
    font-family: 'Outfit', sans-serif;
    font-size: 15px;
    color: var(--gray-400, #888);
    line-height: 1.65;
    margin-bottom: 10px;
  }
  .editors-pick-content time {
    font-family: 'Outfit', sans-serif;
    font-size: 12px;
    color: var(--gray-400, #999);
  }

  /* ===========================================================================
     5. ON VIDEO
     =========================================================================== */
  .video-scroll-row {
    display: flex;
    gap: 20px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding-bottom: 8px;
  }
  .video-scroll-row::-webkit-scrollbar { display: none; }

  .video-card {
    flex: 0 0 180px;
    scroll-snap-align: start;
    text-decoration: none;
    color: inherit;
  }
  .video-card-thumb {
    background: var(--stone, #E0D8CE);
    aspect-ratio: 9/16;
    margin-bottom: 12px;
    border-radius: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }
  .video-card-play {
    width: 44px;
    height: 44px;
    background: rgba(0, 0, 0, 0.45);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s;
  }
  .video-card:hover .video-card-play {
    background: rgba(0, 0, 0, 0.65);
  }
  .video-card-play svg {
    margin-left: 2px;
  }
  .video-card h3 {
    font-family: 'Source Serif 4', serif;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.35;
    color: var(--ink, #1C1714);
  }

  /* ===========================================================================
     Responsive
     =========================================================================== */
  @media (max-width: 768px) {
    .hp-section {
      padding: 48px 0;
    }
    .hero { padding: 0 24px; }
    .hero-inner { grid-template-columns: 1fr; min-height: auto; }
    .hero-image { min-height: 280px; order: -1; }
    .hero-text { padding: 32px 0; border-right: none; }
    .hero-inner h2 { font-size: 28px; }
    .eat-card {
      flex: 0 0 280px;
    }
    .eat-card--first {
      flex: 0 0 320px;
    }
    .kitchen-band {
      padding: 48px 0;
    }
    .kitchen-card {
      flex: 0 0 200px;
    }
    .editors-pick-card {
      grid-template-columns: 1fr;
      gap: 24px;
    }
    .editors-pick-content h2 {
      font-size: 24px;
    }
    .video-card {
      flex: 0 0 150px;
    }
  }

  @media (max-width: 480px) {
    .eat-card,
    .eat-card--first {
      flex: 0 0 260px;
    }
    .section-label--eng {
      font-size: 22px;
    }
  }
</style>`;
}

// ---------------------------------------------------------------------------
// Auto-carousel script (shared across pages)
// ---------------------------------------------------------------------------

const CAROUSEL_SCRIPT = `
<script>
  document.querySelectorAll('.auto-carousel').forEach(carousel => {
    const items = carousel.querySelectorAll('.carousel-item, .carousel-slide');
    if (items.length <= 1) return;
    let current = 0;
    items.forEach((item, i) => { item.style.display = i === 0 ? 'block' : 'none'; });
    setInterval(() => {
      items[current].style.display = 'none';
      current = (current + 1) % items.length;
      items[current].style.display = 'block';
    }, 3000);
  });
</script>`;

// ---------------------------------------------------------------------------
// Pantry Items
// ---------------------------------------------------------------------------

const PANTRY_DS_ID = 'b13b7b7f-60a4-47e2-a6ff-eb6ffcdf062b';

async function fetchPantryItems() {
  try {
    const response = await notion.dataSources.query({
      data_source_id: PANTRY_DS_ID,
    });
    return response.results;
  } catch (err) {
    console.warn('Could not fetch Pantry Items:', err.message);
    return [];
  }
}

function extractPantryItem(page) {
  return {
    title: getProperty(page, 'Name') || getProperty(page, 'Title') || 'Untitled',
    category: getProperty(page, 'Category') || 'Uncategorised',
    description: getProperty(page, 'Description') || '',
    link: getProperty(page, 'Link') || getProperty(page, 'Affiliate Link') || '',
    image: (() => {
      const imgs = getProperty(page, 'Image') || getProperty(page, 'Cover Image') || [];
      return imgs[0] || '';
    })(),
  };
}

function generatePantryPage(items) {
  // Group by category
  const grouped = {};
  for (const item of items) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push(item);
  }

  let sections = '';
  for (const [category, catItems] of Object.entries(grouped)) {
    const cards = catItems
      .map(
        item => `
        <${item.link ? `a href="${escapeHtml(item.link)}" target="_blank" rel="noopener"` : 'div'} class="pantry-card">
          <div class="pantry-card-image"${item.image ? ` style="background-image:url('${escapeHtml(item.image)}');background-size:cover;background-position:center;"` : ''}></div>
          <h3>${escapeHtml(item.title)}</h3>
          ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}
        </${item.link ? 'a' : 'div'}>`
      )
      .join('\n');
    sections += `
    <section class="pantry-section">
      <h2>${escapeHtml(category)}</h2>
      <div class="pantry-grid">
        ${cards}
      </div>
    </section>`;
  }

  if (items.length === 0) {
    sections = `
    <section class="empty-state">
      <p>Pantry items coming soon.</p>
    </section>`;
  }

  return `---
import BaseLayout from '../../layouts/BaseLayout.astro';
---

<BaseLayout title="My Pantry" description="Korean ingredients, kitchen tools, and guides curated for Singapore kitchens.">
  <div class="pantry-page">
    <header class="pantry-header">
      <h1>My Pantry</h1>
      <p class="pantry-desc">Korean ingredients, kitchen tools, and guides curated for Singapore kitchens.</p>
    </header>

    ${sections}
  </div>
</BaseLayout>

<style>
  .pantry-page {
    max-width: 1080px;
    margin: 0 auto;
    padding: 0 24px;
  }
  .pantry-header {
    text-align: center;
    padding: 56px 0 40px;
    border-bottom: 1px solid var(--stone);
    margin-bottom: 40px;
  }
  .pantry-header h1 {
    font-family: 'Source Serif 4', serif;
    font-size: 42px;
    font-weight: 700;
    margin-bottom: 12px;
    color: var(--ink);
  }
  .pantry-desc {
    font-family: 'Outfit', sans-serif;
    font-size: 15px;
    color: var(--gray-400, #999);
    max-width: 480px;
    margin: 0 auto;
  }
  .pantry-section {
    margin-bottom: 48px;
  }
  .pantry-section h2 {
    font-family: 'Outfit', sans-serif;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--gray-400, #999);
    margin-bottom: 24px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--stone);
  }
  .pantry-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 24px;
  }
  .pantry-card {
    text-decoration: none;
    color: inherit;
    display: block;
  }
  .pantry-card-image {
    background: var(--stone);
    aspect-ratio: 1/1;
    margin-bottom: 12px;
  }
  .pantry-card h3 {
    font-family: 'Source Serif 4', serif;
    font-size: 17px;
    font-weight: 700;
    line-height: 1.3;
    margin-bottom: 6px;
    color: var(--ink);
  }
  .pantry-card p {
    font-size: 13px;
    color: var(--gray-400, #999);
    line-height: 1.5;
  }
  .empty-state {
    text-align: center;
    padding: 64px 0;
    color: var(--gray-400, #999);
    font-family: 'Outfit', sans-serif;
    font-size: 15px;
  }
  @media (max-width: 768px) {
    .pantry-header h1 { font-size: 32px; }
    .pantry-grid { grid-template-columns: 1fr 1fr; gap: 16px; }
  }
  @media (max-width: 480px) {
    .pantry-grid { grid-template-columns: 1fr; }
  }
</style>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Fetching published posts from Notion...');
  const pages = await fetchPublishedPosts();
  console.log(`Found ${pages.length} published post(s).`);

  if (pages.length === 0) {
    console.log('No posts with Status = Done and Kill Switch = true. Generating empty pages.');
  }

  // Extract structured data and fetch body blocks for each post
  const allPosts = [];
  for (const page of pages) {
    const post = await extractPostData(page);

    if (!post.slug || !post.pillar) {
      console.warn(`Skipping "${post.title}" - missing slug or pillar.`);
      continue;
    }

    const cfg = PILLAR_CONFIG[post.pillar];
    if (!cfg) {
      console.warn(`Skipping "${post.title}" - unknown pillar "${post.pillar}".`);
      continue;
    }

    console.log(`Fetching blocks for: ${post.title}`);
    const blocks = await getPageBlocks(page.id);
    post.bodyHtml = blocksToHtml(blocks);
    post.plainText = getPlainText(blocks);
    post.excerpt = post.plainText.slice(0, 300);

    allPosts.push(post);
  }

  // -----------------------------------------------------------------------
  // 1. Generate individual article pages
  // -----------------------------------------------------------------------
  for (const post of allPosts) {
    const cfg = PILLAR_CONFIG[post.pillar];
    const dir = path.join(PAGES_DIR, cfg.folder, post.slug);
    fs.mkdirSync(dir, { recursive: true });

    const articlePage = generateArticlePage(post, post.bodyHtml, post.plainText);
    fs.writeFileSync(path.join(dir, 'index.astro'), articlePage);
    console.log(`  Written: src/pages/${cfg.folder}/${post.slug}/index.astro`);
  }

  // -----------------------------------------------------------------------
  // 2. Generate category listing pages
  // -----------------------------------------------------------------------
  for (const [pillar, cfg] of Object.entries(PILLAR_CONFIG)) {
    const pillarPosts = allPosts.filter(p => p.pillar === pillar);
    const categoryPage = generateCategoryPage(pillar, pillarPosts);
    if (!categoryPage) continue;

    const dir = path.join(PAGES_DIR, cfg.folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.astro'), categoryPage);
    console.log(`  Written: src/pages/${cfg.folder}/index.astro (${pillarPosts.length} posts)`);
  }

  // -----------------------------------------------------------------------
  // 3. Generate homepage (delete any static index.astro first to avoid conflict)
  // -----------------------------------------------------------------------
  const homepagePath = path.join(PAGES_DIR, 'index.astro');
  if (fs.existsSync(homepagePath)) {
    fs.unlinkSync(homepagePath);
    console.log('  Deleted existing: src/pages/index.astro');
  }
  const homepageSrc = generateHomepage(allPosts);
  fs.writeFileSync(homepagePath, homepageSrc);
  console.log('  Written: src/pages/index.astro');

  // -----------------------------------------------------------------------
  // 4. Generate Pantry page
  // -----------------------------------------------------------------------
  console.log('Fetching Pantry Items from Notion...');
  const pantryPages = await fetchPantryItems();
  console.log(`Found ${pantryPages.length} pantry item(s).`);
  const pantryItems = pantryPages.map(extractPantryItem);
  const pantryDir = path.join(PAGES_DIR, 'my-pantry');
  fs.mkdirSync(pantryDir, { recursive: true });
  fs.writeFileSync(path.join(pantryDir, 'index.astro'), generatePantryPage(pantryItems));
  console.log('  Written: src/pages/my-pantry/index.astro');

  console.log('Sync complete.');
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
