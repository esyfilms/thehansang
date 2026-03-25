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

function extractPostData(page) {
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

  // Resolve cover URL: use first cover image, fall back to IG thumbnail
  data.coverUrl = data.coverImages[0] || getIgThumbnail(data.videoUrl) || '';

  return data;
}

// ---------------------------------------------------------------------------
// Filter pills config by pillar
// ---------------------------------------------------------------------------

const FILTER_PILLS = {
  Eat: ['All', 'Reviews', 'Guides', 'Listicles', 'New Openings'],
  Cook: ['All', 'Mains', 'Sides', 'Soups & Stews', 'Snacks', 'Drinks'],
  Travel: ['All', 'Seoul', 'Busan', 'Jeju', 'Food Districts'],
  Culture: ['All', 'K-Drama', 'K-Pop', 'Beauty', 'Language'],
  Events: ['All', 'Festival', 'Pop-Up', 'Market', 'Workshop'],
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
        <a href="/${cfg.folder}/${p.slug}/" class="grid-card">
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
      ${(FILTER_PILLS[pillar] || ['All']).map((pill, i) => `<button class="filter-pill${i === 0 ? ' active' : ''}">${pill}</button>`).join('\n      ')}
    </div>

    ${featuredSection}
    ${gridSection}
  </div>
</BaseLayout>

${CAROUSEL_SCRIPT}

<style>
  .category-page {
    max-width: 1080px;
    margin: 0 auto;
    padding: 0 24px;
  }
  .category-header {
    text-align: center;
    padding: 56px 0 40px;
    border-bottom: 1px solid var(--stone);
    margin-bottom: 40px;
  }
  .category-korean {
    display: block;
    font-family: 'Noto Serif KR', serif;
    font-size: 14px;
    color: var(--ember);
    letter-spacing: 0.2em;
    margin-bottom: 8px;
  }
  .category-header h1 {
    font-family: 'Source Serif 4', serif;
    font-size: 42px;
    font-weight: 700;
    margin-bottom: 12px;
    color: var(--ink);
  }
  .category-desc {
    font-family: 'Outfit', sans-serif;
    font-size: 15px;
    color: var(--gray-400, #999);
    max-width: 480px;
    margin: 0 auto;
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
  // Categorise posts by homepage position
  const heroPosts = allPosts.filter(p => p.homepagePosition === 'Hero');
  const koreanEatsPosts = allPosts.filter(p => p.homepagePosition === 'Korean Eats').length > 0
    ? allPosts.filter(p => p.homepagePosition === 'Korean Eats')
    : allPosts.filter(p => p.pillar === 'Eat').slice(0, 6);
  const kitchenPosts = allPosts.filter(p => p.homepagePosition === 'From the Kitchen').length > 0
    ? allPosts.filter(p => p.homepagePosition === 'From the Kitchen')
    : allPosts.filter(p => p.pillar === 'Cook').slice(0, 4);
  const editorsPick = allPosts.find(p => p.homepagePosition === 'Editors Pick') || null;
  const videoPosts = allPosts.filter(p => p.videoUrl).slice(0, 6);

  // Hero section
  let heroSection = '';
  if (heroPosts.length === 1) {
    const h = heroPosts[0];
    const folder = PILLAR_CONFIG[h.pillar]?.folder || 'eat';
    heroSection = `
    <section class="hero">
      <a href="/${folder}/${h.slug}/" class="hero-card">
        <div class="hero-image"${h.coverUrl ? ` style="background-image:url('${escapeHtml(h.coverUrl)}');background-size:cover;background-position:center;"` : ''}></div>
        <div class="hero-content">
          <div class="hero-tag">${(h.pillar || '').toUpperCase()} &middot; ${(h.postType || '').toUpperCase()}</div>
          <h2>${escapeHtml(h.title)}</h2>
          <p>${escapeHtml((h.excerpt || '').slice(0, 200))}</p>
          <time datetime="${h.date || ''}">${formatDate(h.date)}</time>
        </div>
      </a>
    </section>`;
  } else if (heroPosts.length > 1) {
    const items = heroPosts
      .map(h => {
        const folder = PILLAR_CONFIG[h.pillar]?.folder || 'eat';
        return `
        <div class="carousel-item">
          <a href="/${folder}/${h.slug}/" class="hero-card">
            <div class="hero-image"${h.coverUrl ? ` style="background-image:url('${escapeHtml(h.coverUrl)}');background-size:cover;background-position:center;"` : ''}></div>
            <div class="hero-content">
              <div class="hero-tag">${(h.pillar || '').toUpperCase()} &middot; ${(h.postType || '').toUpperCase()}</div>
              <h2>${escapeHtml(h.title)}</h2>
              <p>${escapeHtml((h.excerpt || '').slice(0, 200))}</p>
              <time datetime="${h.date || ''}">${formatDate(h.date)}</time>
            </div>
          </a>
        </div>`;
      })
      .join('\n');
    heroSection = `
    <section class="hero auto-carousel">
      ${items}
    </section>`;
  }

  // Korean Eats carousel
  let koreanEatsSection = '';
  if (koreanEatsPosts.length > 0) {
    const cards = koreanEatsPosts
      .map(p => {
        const folder = PILLAR_CONFIG[p.pillar]?.folder || 'eat';
        return `
        <a href="/${folder}/${p.slug}/" class="scroll-card">
          <div class="scroll-card-image"${p.coverUrl ? ` style="background-image:url('${escapeHtml(p.coverUrl)}');background-size:cover;background-position:center;"` : ''}></div>
          <div class="scroll-card-tag">${(p.pillar || '').toUpperCase()} &middot; ${(p.postType || '').toUpperCase()}</div>
          <h3>${escapeHtml(p.title)}</h3>
          <time datetime="${p.date || ''}">${formatDate(p.date)}</time>
        </a>`;
      })
      .join('\n');
    koreanEatsSection = `
    <section class="home-section">
      <div class="section-header">
        <span class="section-korean">\uBA39\uB2E4</span>
        <h2>Korean Eats</h2>
      </div>
      <div class="scroll-row">
        ${cards}
      </div>
    </section>`;
  }

  // From the Kitchen (dark band)
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
        <div class="section-header section-header-light">
          <span class="section-korean">\uC694\uB9AC\uD558\uB2E4</span>
          <h2>From the Kitchen</h2>
        </div>
        <div class="kitchen-grid">
          ${cards}
        </div>
      </div>
    </section>`;
  }

  // Editor's Pick
  let editorsPickSection = '';
  if (editorsPick) {
    const folder = PILLAR_CONFIG[editorsPick.pillar]?.folder || 'eat';
    editorsPickSection = `
    <section class="editors-pick">
      <a href="/${folder}/${editorsPick.slug}/" class="editors-pick-card">
        <div class="editors-pick-label">Editor's Pick</div>
        <div class="editors-pick-image"${editorsPick.coverUrl ? ` style="background-image:url('${escapeHtml(editorsPick.coverUrl)}');background-size:cover;background-position:center;"` : ''}></div>
        <div class="editors-pick-content">
          <h2>${escapeHtml(editorsPick.title)}</h2>
          <p>${escapeHtml((editorsPick.excerpt || '').slice(0, 200))}</p>
        </div>
      </a>
    </section>`;
  }

  // On Video carousel
  let videoSection = '';
  if (videoPosts.length > 0) {
    const cards = videoPosts
      .map(p => {
        const folder = PILLAR_CONFIG[p.pillar]?.folder || 'eat';
        return `
        <a href="/${folder}/${p.slug}/" class="video-card">
          <div class="video-card-thumb"${p.coverUrl ? ` style="background-image:url('${escapeHtml(p.coverUrl)}');background-size:cover;background-position:center;"` : ''}>
            <div class="video-card-play"></div>
          </div>
          <h3>${escapeHtml(p.title)}</h3>
        </a>`;
      })
      .join('\n');
    videoSection = `
    <section class="home-section">
      <div class="section-header">
        <h2>On Video</h2>
      </div>
      <div class="scroll-row">
        ${cards}
      </div>
    </section>`;
  }

  return `---
import BaseLayout from '../layouts/BaseLayout.astro';
---

<BaseLayout title="The Hansang - Everything Korea, for Singapore" description="The definitive Korean food, culture and lifestyle authority in Singapore.">
  <div class="homepage">

    <!-- Launch banner -->
    <div class="launch-banner">
      <p>Welcome to <strong>The Hansang</strong> \u2014 Everything Korea, for Singapore.</p>
    </div>

    ${heroSection}
    ${koreanEatsSection}
    ${kitchenSection}
    ${editorsPickSection}
    ${videoSection}

  </div>
</BaseLayout>

${CAROUSEL_SCRIPT}

<style>
  .homepage {
    width: 100%;
  }

  /* ---- Launch banner ---- */
  .launch-banner {
    background: var(--ink, #1C1714);
    color: var(--cream, #F7F3ED);
    text-align: center;
    padding: 12px 24px;
    font-family: 'Outfit', sans-serif;
    font-size: 13px;
    letter-spacing: 0.04em;
  }
  .launch-banner strong {
    color: var(--ember);
  }

  /* ---- Hero ---- */
  .hero {
    max-width: 1080px;
    margin: 0 auto;
    padding: 48px 24px;
  }
  .hero-card {
    display: grid;
    grid-template-columns: 1.2fr 1fr;
    gap: 40px;
    text-decoration: none;
    color: inherit;
  }
  .hero-image {
    background: var(--stone);
    aspect-ratio: 16/10;
  }
  .hero-content {
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .hero-tag {
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ember);
    margin-bottom: 16px;
    font-family: 'Outfit', sans-serif;
  }
  .hero-content h2 {
    font-family: 'Source Serif 4', serif;
    font-size: 34px;
    font-weight: 700;
    line-height: 1.2;
    margin-bottom: 16px;
    color: var(--ink);
  }
  .hero-content p {
    font-size: 15px;
    color: var(--gray-400, #999);
    line-height: 1.6;
    margin-bottom: 12px;
  }
  .hero-content time {
    font-size: 12px;
    color: var(--gray-400, #999);
    font-family: 'Outfit', sans-serif;
  }

  .carousel-item {
    display: none;
  }
  .carousel-item:first-child {
    display: block;
  }

  /* ---- Section headers ---- */
  .home-section {
    max-width: 1080px;
    margin: 0 auto;
    padding: 48px 24px;
  }
  .section-header {
    margin-bottom: 32px;
  }
  .section-korean {
    display: block;
    font-family: 'Noto Serif KR', serif;
    font-size: 12px;
    color: var(--ember);
    letter-spacing: 0.2em;
    margin-bottom: 4px;
  }
  .section-header h2 {
    font-family: 'Source Serif 4', serif;
    font-size: 28px;
    font-weight: 700;
    color: var(--ink);
  }
  .section-header-light h2 {
    color: var(--cream, #F7F3ED);
  }
  .section-header-light .section-korean {
    color: var(--ember);
  }

  /* ---- Scroll row ---- */
  .scroll-row {
    display: flex;
    gap: 24px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    padding-bottom: 8px;
  }
  .scroll-row::-webkit-scrollbar {
    display: none;
  }
  .scroll-card {
    flex: 0 0 260px;
    text-decoration: none;
    color: inherit;
  }
  .scroll-card-image {
    background: var(--stone);
    aspect-ratio: 3/2;
    margin-bottom: 12px;
  }
  .scroll-card-tag {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ember);
    margin-bottom: 6px;
    font-family: 'Outfit', sans-serif;
  }
  .scroll-card h3 {
    font-family: 'Source Serif 4', serif;
    font-size: 17px;
    font-weight: 700;
    line-height: 1.3;
    margin-bottom: 6px;
    color: var(--ink);
  }
  .scroll-card time {
    font-size: 12px;
    color: var(--gray-400, #999);
    font-family: 'Outfit', sans-serif;
  }

  /* ---- Kitchen dark band ---- */
  .kitchen-band {
    background: var(--ink, #1C1714);
    padding: 56px 0;
    margin: 24px 0;
  }
  .kitchen-inner {
    max-width: 1080px;
    margin: 0 auto;
    padding: 0 24px;
  }
  .kitchen-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 24px;
  }
  .kitchen-card {
    text-decoration: none;
    color: var(--cream, #F7F3ED);
  }
  .kitchen-card-image {
    background: var(--stone);
    aspect-ratio: 1/1;
    margin-bottom: 12px;
    opacity: 0.9;
  }
  .kitchen-card h3 {
    font-family: 'Source Serif 4', serif;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.3;
    margin-bottom: 6px;
  }
  .kitchen-card time {
    font-size: 12px;
    color: var(--gray-400, #999);
    font-family: 'Outfit', sans-serif;
  }

  /* ---- Editor's Pick ---- */
  .editors-pick {
    max-width: 1080px;
    margin: 0 auto;
    padding: 48px 24px;
  }
  .editors-pick-card {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 40px;
    text-decoration: none;
    color: inherit;
    position: relative;
  }
  .editors-pick-label {
    position: absolute;
    top: 16px;
    left: 16px;
    background: var(--ember);
    color: #fff;
    font-family: 'Outfit', sans-serif;
    font-size: 10px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    padding: 6px 14px;
    z-index: 1;
  }
  .editors-pick-image {
    background: var(--stone);
    aspect-ratio: 16/9;
  }
  .editors-pick-content {
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .editors-pick-content h2 {
    font-family: 'Source Serif 4', serif;
    font-size: 30px;
    font-weight: 700;
    line-height: 1.25;
    margin-bottom: 16px;
    color: var(--ink);
  }
  .editors-pick-content p {
    font-size: 15px;
    color: var(--gray-400, #999);
    line-height: 1.6;
  }

  /* ---- On Video ---- */
  .video-card {
    flex: 0 0 180px;
    text-decoration: none;
    color: inherit;
  }
  .video-card-thumb {
    background: var(--stone);
    aspect-ratio: 9/16;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }
  .video-card-play {
    width: 40px;
    height: 40px;
    background: rgba(0, 0, 0, 0.5);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .video-card-play::after {
    content: '';
    border-style: solid;
    border-width: 7px 0 7px 12px;
    border-color: transparent transparent transparent white;
    margin-left: 2px;
  }
  .video-card h3 {
    font-family: 'Source Serif 4', serif;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--ink);
  }

  @media (max-width: 768px) {
    .hero-card {
      grid-template-columns: 1fr;
      gap: 24px;
    }
    .hero-content h2 {
      font-size: 26px;
    }
    .kitchen-grid {
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .editors-pick-card {
      grid-template-columns: 1fr;
      gap: 24px;
    }
    .editors-pick-content h2 {
      font-size: 24px;
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
    const items = carousel.querySelectorAll('.carousel-item');
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
    const post = extractPostData(page);

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
  // 3. Generate homepage
  // -----------------------------------------------------------------------
  const homepageSrc = generateHomepage(allPosts);
  fs.writeFileSync(path.join(PAGES_DIR, 'index.astro'), homepageSrc);
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
