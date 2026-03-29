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
const ADS_DS_ID   = '761a79d4-766c-4d75-8f09-f41a8e559696';
const ALERTS_DS_ID = '8461c7ea-9b01-4919-b476-84a0f9b44526';
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
  Directory: {
    folder: 'directory',
    korean: '\uBAA9\uB85D',
    english: 'Directory',
    description: 'Korean businesses, services, and resources in Singapore.',
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

async function fetchActiveSiteAlert() {
  if (!ALERTS_DS_ID) return null;
  try {
    const response = await notion.dataSources.query({
      data_source_id: ALERTS_DS_ID,
      filter: { property: 'Active', checkbox: { equals: true } },
    });
    const page = response.results[0];
    if (!page) return null;
    return {
      active: true,
      message: getProperty(page, 'Message') || '',
      type: getProperty(page, 'Type') || 'Info',
      link: getProperty(page, 'Link') || '',
    };
  } catch (e) {
    console.warn('Could not fetch site alert:', e.message);
    return null;
  }
}

async function fetchActiveAds() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const response = await notion.dataSources.query({
      data_source_id: ADS_DS_ID,
      filter: { property: 'Active', checkbox: { equals: true } },
    });
    return response.results
      .map(page => ({
        sponsorName: getProperty(page, 'Sponsor Name') || '',
        displayText: getProperty(page, 'Display Text') || '',
        placement:   getProperty(page, 'Placement') || '',
        linkUrl:     getProperty(page, 'Link URL') || '#',
        startDate:   getProperty(page, 'Start Date') || '',
        endDate:     getProperty(page, 'End Date') || '',
        bannerImages: getProperty(page, 'Banner Image') || [],
      }))
      .filter(ad => {
        // Only include ads within date range (if dates are set)
        if (ad.startDate && ad.startDate > today) return false;
        if (ad.endDate && ad.endDate < today) return false;
        return true;
      });
  } catch (e) {
    console.warn('Could not fetch ads:', e.message);
    return [];
  }
}

function getAdHtml(ads, placement, fallback = '') {
  const ad = ads.find(a => a.placement === placement);
  if (!ad) return fallback;
  const img = ad.bannerImages[0]
    ? `<img src="${escapeHtml(ad.bannerImages[0])}" alt="${escapeHtml(ad.sponsorName)}" style="max-width:100%;display:block;">`
    : `<span>${escapeHtml(ad.displayText || ad.sponsorName)}</span>`;
  return `<a href="${escapeHtml(ad.linkUrl)}" target="_blank" rel="noopener sponsored" class="ad-slot-link">${img}</a>`;
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
    sortOrder: getProperty(page, 'Sort Order'),
    contributor: getProperty(page, 'Contributor'),
    affiliateLink: getProperty(page, 'Affiliate Link'),
    recipeCategory: getProperty(page, 'Recipe Category') || [],
    coverImages: getProperty(page, 'Cover Image') || [],
    googleMapsUrl: getProperty(page, 'Google Maps URL') || '',
    excerpt: getProperty(page, 'Excerpt') || '',
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
    { label: 'Mains', filter: 'mains' },
    { label: 'Banchan', filter: 'banchan' },
    { label: 'Soups & Stews', filter: 'soups & stews' },
    { label: 'Snacks', filter: 'snacks' },
    { label: 'Hacks', filter: 'hacks' },
    { label: 'Noodles', filter: 'noodles' },
  ],
  Travel: [
    { label: 'All', filter: 'all' },
    { label: 'Seoul Eats', filter: 'seoul eats' },
    { label: 'Seoul Cafe', filter: 'seoul cafe' },
    { label: 'Seoul Visit', filter: 'seoul visit' },
    { label: 'Seoul Shops', filter: 'seoul shops' },
    { label: 'Seoul Nights', filter: 'seoul nights' },
  ],
  Culture: [
    { label: 'All', filter: 'all' },
    { label: 'K-Drama', filter: 'kdrama' },
    { label: 'K-Pop', filter: 'kpop' },
    { label: 'Beauty', filter: 'beauty' },
    { label: 'Language', filter: 'language' },
  ],
  Directory: [
    { label: 'All', filter: 'all' },
    { label: 'Restaurants', filter: 'restaurant' },
    { label: 'Groceries', filter: 'grocery' },
    { label: 'Services', filter: 'service' },
  ],
};

// ---------------------------------------------------------------------------
// 1. Generate individual article page
// ---------------------------------------------------------------------------

function generateArticlePage(post, bodyHtml, plainText, allPosts = [], ads = []) {
  const pillarCfg = PILLAR_CONFIG[post.pillar] || PILLAR_CONFIG.Eat;
  const pillarTag = `${(post.pillar || 'Eat').toUpperCase()} &middot; ${(post.postType || 'Article').toUpperCase()}`;
  const contributor = post.contributor || DEFAULT_AUTHOR;
  const dateFormatted = formatDate(post.date);
  const readTime = estimateReadTime(plainText);
  const isRecipe = post.postType === 'Recipe';
  const isReview = post.postType === 'Review';
  const pillarFolder = pillarCfg.folder || 'eat';

  // Instagram embed
  const videoEmbed = buildIgEmbed(post.videoUrl);

  // Info card (Quick Take for reviews, Recipe Card for recipes)
  let infoCard = '';
  if (isRecipe) {
    infoCard = `
      <div class="info-card">
        <h3>Recipe Card</h3>
        <div class="info-grid">
          <div class="info-item"><div class="info-label">Servings</div><div class="info-value">${post.servings || '-'}</div></div>
          <div class="info-item"><div class="info-label">Prep Time</div><div class="info-value">${post.prepTime ? post.prepTime + ' min' : '-'}</div></div>
          <div class="info-item"><div class="info-label">Cook Time</div><div class="info-value">${post.cookTime ? post.cookTime + ' min' : '-'}</div></div>
          <div class="info-item"><div class="info-label">Difficulty</div><div class="info-value">${post.difficulty || '-'}</div></div>
        </div>
      </div>`;
  } else if (isReview) {
    infoCard = `
      <div class="info-card">
        <h3>Quick Take</h3>
        <div class="info-grid">
          <div class="info-item"><div class="info-label">Rating</div><div class="info-value">${post.rating || '-'} / 10</div></div>
          <div class="info-item"><div class="info-label">Price Range</div><div class="info-value">${post.priceRange || '-'}</div></div>
          <div class="info-item"><div class="info-label">Best Dish</div><div class="info-value">${post.bestDish || '-'}</div></div>
          <div class="info-item"><div class="info-label">Skip This</div><div class="info-value">${post.skipThis || '-'}</div></div>
        </div>
      </div>`;
  }

  // My Pantry Affiliate Picks (replaces old Singapore Swap)
  let sgSwapBlock = '';
  if (post.pillar === 'Cook') {
    sgSwapBlock = `
      <div class="pantry-picks">
        <div class="pantry-picks-hd">
          <span class="pantry-picks-label">From My Pantry</span>
          <a href="/my-pantry/" class="pantry-picks-link">View All</a>
        </div>
        <div class="pantry-picks-grid" id="article-pantry-picks">
          <a class="pantry-pick" href="/my-pantry/">
            <div class="pp-img"></div>
            <span class="pp-badge">Essential</span>
            <span class="pp-name">Product Placeholder</span>
            <span class="pp-cta">Shop Now</span>
          </a>
          <a class="pantry-pick" href="/my-pantry/">
            <div class="pp-img"></div>
            <span class="pp-badge">Essential</span>
            <span class="pp-name">Product Placeholder</span>
            <span class="pp-cta">Shop Now</span>
          </a>
          <a class="pantry-pick" href="/my-pantry/">
            <div class="pp-img"></div>
            <span class="pp-badge">Essential</span>
            <span class="pp-name">Product Placeholder</span>
            <span class="pp-cta">Shop Now</span>
          </a>
        </div>
        <p class="pantry-picks-note">Links may earn a small commission at no extra cost to you.</p>
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
      <div class="info-card restaurant-info">
        <h3>Restaurant Info</h3>
        <div class="info-grid">
          ${post.restaurantAddress ? `<div class="info-item"><div class="info-label">Address</div><div class="info-value">${escapeHtml(post.restaurantAddress)}<a href="${post.googleMapsUrl || `https://maps.google.com/?q=${encodeURIComponent(post.restaurantAddress)}`}" target="_blank" rel="noopener" class="directions-link">Get Directions &rarr;</a></div></div>` : ''}
          ${post.restaurantMRT ? `<div class="info-item"><div class="info-label">MRT</div><div class="info-value">${escapeHtml(post.restaurantMRT)}</div></div>` : ''}
          ${post.restaurantHours ? `<div class="info-item"><div class="info-label">Hours</div><div class="info-value">${escapeHtml(post.restaurantHours)}</div></div>` : ''}
          ${post.priceRange ? `<div class="info-item"><div class="info-label">Price Range</div><div class="info-value">${escapeHtml(post.priceRange)} per person</div></div>` : ''}
          ${post.reservation ? `<div class="info-item"><div class="info-label">Reservation</div><div class="info-value">${escapeHtml(post.reservation)}</div></div>` : ''}
          <div class="info-item"><div class="info-label">Halal</div><div class="info-value">${post.halal ? 'Yes' : 'No'}</div></div>
        </div>
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

  // Tags
  const tagsArray = Array.isArray(post.recipeCategory) ? post.recipeCategory : [];
  let tagsBlock = '';
  if (tagsArray.length > 0) {
    tagsBlock = `
      <div class="article-tags">
        <div class="tags-label">Tags</div>
        <div class="tags-list">
          ${tagsArray.map(t => `<a href="/${pillarFolder}/" class="tag">${escapeHtml(t)}</a>`).join('\n          ')}
        </div>
      </div>`;
  }

  return `---
import BaseLayout from '../../../layouts/BaseLayout.astro';
---

<BaseLayout title="${escapeHtml(post.title)}" description="${escapeHtml(post.meta)}">

  <!-- ===== HERO IMAGE + OVERLAY ===== -->
  <div class="article-hero">
    ${post.coverUrl
      ? `<div class="hero-bg" style="background: url('${escapeHtml(post.coverUrl)}') center/cover no-repeat;"></div>`
      : `<div class="hero-bg"></div>`}
    <div class="hero-overlay">
      <div class="breadcrumb"><a href="/">Home</a> &nbsp;|&nbsp; <a href="/${pillarFolder}/">${escapeHtml(pillarCfg.english)}</a> &nbsp;|&nbsp; ${escapeHtml(post.postType || 'Article')}</div>
      <div class="pillar-tag">${pillarTag}</div>
      <h1>${escapeHtml(post.title)}</h1>
      ${post.meta ? `<p class="subtitle">${escapeHtml(post.meta)}</p>` : ''}
    </div>
  </div>

  <!-- ===== META BAR (author, date, share) ===== -->
  <div class="article-meta-bar">
    <div class="meta-left">
      <span>By ${escapeHtml(contributor)}</span>
      <span>${dateFormatted || 'Coming Soon'}</span>
      <span>${readTime} min read</span>
    </div>
    <div class="share-icons">
      <span class="share-label">Share</span>
      <a href="#" class="share-btn" data-share="copy" title="Copy link">&#128279;</a>
      <a href="https://www.instagram.com/" class="share-btn" target="_blank" rel="noopener" title="Instagram">IG</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=ARTICLE_URL" class="share-btn" target="_blank" rel="noopener" title="Facebook">f</a>
      <a href="https://wa.me/?text=${encodeURIComponent(post.title)}%20ARTICLE_URL" class="share-btn" target="_blank" rel="noopener" title="WhatsApp">&#9742;</a>
      <a href="https://www.threads.net/intent/post?text=${encodeURIComponent(post.title)}%20ARTICLE_URL" class="share-btn" target="_blank" rel="noopener" title="Threads">&#129525;</a>
    </div>
    <span class="copy-toast" id="copyToast">Link copied!</span>
  </div>

  <!-- ===== ARTICLE BODY + SIDEBAR ===== -->
  <div class="article-layout">
    <article class="article-body">

      ${videoEmbed}
      ${infoCard}

      ${bodyHtml}

      ${sgSwapBlock}
      ${affiliateBlock}
      ${restaurantInfo}
      ${verdict}

      ${tagsBlock}

    </article>

    <!-- ===== SIDEBAR ===== -->
    <aside class="article-sidebar">
      <div class="sidebar-section">
        <h4>Recommendations</h4>
        <div class="sidebar-recs-placeholder" data-pillar="${pillarFolder}"></div>
      </div>

      <div class="sidebar-ad">${getAdHtml(ads, 'Sidebar 300x250', 'Ad &middot; 300&times;250')}</div>

      <div class="sidebar-section">
        <h4>Most Read</h4>
        <div class="sidebar-most-read-placeholder" data-pillar="${pillarFolder}"></div>
      </div>
    </aside>
  </div>

  <!-- ===== AD SPACE ===== -->
  <div class="ad-space">
    ${getAdHtml(ads, 'Article Mid-Content', '<span>Ad Space</span>')}
  </div>

  <!-- ===== MORE FROM THE HANSANG ===== -->
  <div class="more-articles">
    <div class="section-header">
      <h3>More from The Hansang</h3>
      <a href="/${pillarFolder}/">View All</a>
    </div>
    <div class="more-grid">
      ${allPosts
        .filter(p => p.pillar === post.pillar && p.slug !== post.slug)
        .slice(0, 4)
        .map(p => {
          const cfg2 = PILLAR_CONFIG[p.pillar] || {};
          const imgHtml = p.coverUrl
            ? `<img src="${escapeHtml(p.coverUrl)}" alt="${escapeHtml(p.title)}" loading="lazy">`
            : `<div style="width:100%;height:100%;background:linear-gradient(145deg,#E0D8CE,#C8BEB5);"></div>`;
          return `<a href="/${cfg2.folder || pillarFolder}/${p.slug}/" class="more-card">
              <div class="more-img">${imgHtml}</div>
              <div class="more-tag">${escapeHtml(p.pillar || '')} &middot; ${escapeHtml(p.postType || '')}</div>
              <h4>${escapeHtml(p.title)}</h4>
              <div class="card-meta">${p.date ? new Date(p.date).toLocaleDateString('en-SG', {day:'numeric',month:'short',year:'numeric'}) : ''}</div>
            </a>`;
        }).join('\n      ')}
    </div>
  </div>

<script>
  // Replace ARTICLE_URL placeholders with actual page URL
  document.querySelectorAll('.share-btn').forEach(link => {
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
  /* ===== HERO IMAGE WITH OVERLAY ===== */
  .article-hero {
    position: relative;
    max-width: 1100px;
    margin: 0 auto;
    height: 480px;
    overflow: hidden;
  }
  .article-hero .hero-bg {
    width: 100%;
    height: 100%;
    background: linear-gradient(145deg, #d4a574 0%, #8b6548 50%, #5a4030 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255,255,255,0.2);
    font-size: 14px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .article-hero .hero-overlay {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    bottom: 0;
    left: 0;
    right: 0;
    padding: 48px;
    background: linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 60%, transparent 100%);
  }
  .hero-overlay .breadcrumb {
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.6);
    margin-bottom: 12px;
  }
  .hero-overlay .breadcrumb a {
    color: rgba(255,255,255,0.6);
    text-decoration: none;
  }
  .hero-overlay .breadcrumb a:hover { color: #fff; }
  .hero-overlay .pillar-tag {
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #B8432A;
    margin-bottom: 14px;
  }
  .hero-overlay h1 {
    font-family: 'Source Serif 4', serif;
    font-size: 36px;
    font-weight: 600;
    color: #FFFFFF;
    line-height: 1.25;
    margin-bottom: 12px;
    max-width: 700px;
  }
  .hero-overlay .subtitle {
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    color: rgba(255,255,255,0.75);
    line-height: 1.5;
    max-width: 600px;
  }

  /* ===== ARTICLE META BAR ===== */
  .article-meta-bar {
    position: relative;
    max-width: 1100px;
    margin: 0 auto;
    padding: 20px 40px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 2px solid #eee;
  }
  .meta-left {
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #999;
  }
  .meta-left span { margin-right: 16px; }

  /* Share icons — circular buttons */
  .share-icons {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .share-icons .share-label {
    font-family: 'Inter', sans-serif;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #999;
    margin-right: 8px;
  }
  .share-btn {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid #ddd;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
    text-decoration: none;
    color: #666;
    font-size: 13px;
  }
  .share-btn:hover { border-color: #1C1714; background: #f8f8f8; }
  .copy-toast {
    position: absolute;
    top: -12px;
    right: 40px;
    background: #1C1714;
    color: #F7F3ED;
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

  /* ===== ARTICLE BODY + SIDEBAR GRID ===== */
  .article-layout {
    max-width: 1100px;
    margin: 0 auto;
    padding: 40px 40px 0;
    display: grid;
    grid-template-columns: 1fr 280px;
    gap: 48px;
  }

  /* Main article body */
  .article-body {
    max-width: 660px;
  }
  .article-body p {
    font-family: 'Source Serif 4', serif;
    font-size: 18px;
    line-height: 1.8;
    color: #333;
    margin-bottom: 24px;
  }
  .article-body h2 {
    font-family: 'Source Serif 4', serif;
    font-size: 24px;
    font-weight: 600;
    color: #1C1714;
    margin: 40px 0 16px;
    line-height: 1.3;
  }
  .article-body h3 {
    font-family: 'Source Serif 4', serif;
    font-size: 20px;
    font-weight: 600;
    color: #1C1714;
    margin: 32px 0 12px;
  }
  .article-body ul,
  .article-body ol {
    font-family: 'Source Serif 4', serif;
    font-size: 18px;
    line-height: 1.8;
    margin-bottom: 24px;
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
  .article-body blockquote {
    border-left: 3px solid #B8432A;
    padding: 4px 0 4px 24px;
    margin: 32px 0;
    font-style: italic;
    color: #666;
  }
  .article-body figure {
    margin: 32px 0;
    border-radius: 4px;
    overflow: hidden;
  }
  .article-body img {
    width: 100%;
    height: auto;
    display: block;
  }
  .article-body figcaption {
    font-family: 'Inter', sans-serif;
    font-size: 12px;
    color: #999;
    margin-top: 8px;
    font-style: italic;
  }
  .article-body hr {
    border: none;
    border-top: 1px solid #eee;
    margin: 32px 0;
  }
  .article-body .callout {
    background: #EDE6DC;
    padding: 16px 20px;
    margin: 24px 0;
    border-left: 3px solid #B8432A;
    font-size: 16px;
  }

  /* IG Video Embed */
  .article-video {
    background: #fafafa;
    border: 1px solid #eee;
    border-radius: 8px;
    padding: 24px;
    margin: 32px 0;
    text-align: center;
  }
  .article-video iframe {
    display: block;
    margin: 0 auto;
    max-width: 100%;
    border-radius: 6px;
  }
  .article-video-caption {
    font-size: 11px;
    color: #999;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-top: 12px;
  }

  /* Info card (Quick Take / Recipe Card) */
  .info-card {
    background: #fafafa;
    border: 1px solid #eee;
    border-radius: 8px;
    padding: 28px;
    margin: 32px 0;
  }
  .info-card h3 {
    font-family: 'Inter', sans-serif;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #1C1714;
    margin: 0 0 16px;
    padding-bottom: 12px;
    border-bottom: 2px solid #eee;
  }
  .info-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .info-item .info-label {
    font-family: 'Inter', sans-serif;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #999;
    margin-bottom: 4px;
  }
  .info-item .info-value {
    font-family: 'Source Serif 4', serif;
    font-size: 16px;
    font-weight: 500;
    color: #1C1714;
  }
  .directions-link {
    display: inline-block;
    margin-top: 6px;
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: #B8432A;
    text-decoration: none;
  }
  .directions-link:hover { text-decoration: underline; }

  /* My Pantry Affiliate Picks */
  .pantry-picks { border-top: 4px solid #6B4C3B; padding: 24px 0; margin: 32px 0; }
  .pantry-picks-hd { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .pantry-picks-label { font-family: 'Inter', sans-serif; font-size: 11px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: #1C1714; }
  .pantry-picks-link { font-family: 'Inter', sans-serif; font-size: 10px; letter-spacing: 0.09em; text-transform: uppercase; color: #B8432A; text-decoration: none; }
  .pantry-picks-link:hover { text-decoration: underline; }
  .pantry-picks-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .pantry-pick { text-decoration: none; color: #1C1714; display: block; border: 1px solid #eee; border-radius: 6px; overflow: hidden; transition: box-shadow 0.15s; }
  .pantry-pick:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
  .pp-img { height: 120px; background: #E0D8CE; }
  .pp-badge { display: block; font-family: 'Inter', sans-serif; font-size: 8px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: #B8432A; padding: 10px 12px 0; }
  .pp-name { display: block; font-family: 'Source Serif 4', serif; font-size: 14px; font-weight: 500; line-height: 1.3; padding: 4px 12px 0; color: #1C1714; }
  .pp-cta { display: block; font-family: 'Inter', sans-serif; font-size: 10px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: #B8432A; padding: 8px 12px 12px; }
  .pantry-picks-note { font-family: 'Inter', sans-serif; font-size: 10px; color: #bbb; margin-top: 12px; text-align: center; }

  /* Affiliate link */
  .affiliate-link {
    margin: 32px 0;
    text-align: center;
  }
  .affiliate-link a {
    display: inline-block;
    padding: 12px 32px;
    background: #B8432A;
    color: #fff;
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-decoration: none;
    text-transform: uppercase;
    border-radius: 4px;
    transition: opacity 0.2s;
  }
  .affiliate-link a:hover {
    opacity: 0.85;
  }

  /* Verdict */
  .verdict {
    margin: 40px 0;
    padding-top: 32px;
    border-top: 2px solid #eee;
  }
  .verdict h2 {
    font-family: 'Source Serif 4', serif;
    font-size: 24px;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .verdict-rating {
    font-family: 'Source Serif 4', serif;
    font-size: 48px;
    font-weight: 700;
    color: #B8432A;
  }
  .verdict-of {
    font-size: 20px;
    color: #999;
    font-weight: 400;
  }

  /* Tags */
  .article-tags {
    margin: 40px 0;
    padding-top: 24px;
    border-top: 2px solid #eee;
  }
  .article-tags .tags-label {
    font-family: 'Inter', sans-serif;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #999;
    margin-bottom: 12px;
  }
  .tags-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .tag {
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    letter-spacing: 0.06em;
    color: #666;
    padding: 6px 14px;
    border: 1px solid #ddd;
    border-radius: 20px;
    text-decoration: none;
    transition: border-color 0.2s, color 0.2s;
  }
  .tag:hover { border-color: #B8432A; color: #B8432A; }

  /* ===== SIDEBAR ===== */
  .article-sidebar {
    padding-top: 0;
    border-left: 2px solid #eee;
    padding-left: 32px;
  }
  .sidebar-section {
    margin-bottom: 32px;
  }
  .sidebar-section h4 {
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 2px solid #eee;
  }
  .rec-card {
    margin-bottom: 20px;
    cursor: pointer;
  }
  .rec-card .rec-img {
    height: 140px;
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .rec-card .rec-img img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 0.4s ease;
  }
  .rec-card:hover .rec-img img { transform: scale(1.03); }
  .rec-card .rec-tag {
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #B8432A;
    margin-bottom: 4px;
  }
  .rec-card h5 {
    font-family: 'Source Serif 4', serif;
    font-size: 14px;
    font-weight: 500;
    color: #1C1714;
    line-height: 1.3;
    margin-bottom: 4px;
  }
  .rec-card .card-meta {
    font-size: 10px;
    color: #bbb;
  }
  .sidebar-ad {
    border: 1px dashed #ccc;
    border-radius: 4px;
    height: 250px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #bbb;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-bottom: 24px;
  }

  /* ===== AD SPACE (between tags and more articles) ===== */
  .ad-space {
    max-width: 1100px;
    margin: 40px auto;
    padding: 0 40px;
  }
  .ad-space span {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 120px;
    border: 1px dashed #ccc;
    border-radius: 4px;
    color: #bbb;
    font-family: 'Inter', sans-serif;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  /* ===== MORE ARTICLES (bottom) ===== */
  .more-articles {
    max-width: 1100px;
    margin: 0 auto;
    padding: 0 40px 60px;
  }
  .more-articles .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 32px 0 24px;
    border-top: 5px solid #6B4C3B;
  }
  .more-articles .section-header h3 {
    font-family: 'Inter', sans-serif;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .more-articles .section-header a {
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    color: #B8432A;
    text-decoration: none;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .more-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 24px;
  }
  .more-card { cursor: pointer; text-decoration: none; color: inherit; }
  .more-card .more-img {
    height: 160px;
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 10px;
  }
  .more-card .more-img img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 0.4s ease;
  }
  .more-card:hover .more-img img { transform: scale(1.03); }
  .more-card .more-tag {
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #B8432A;
    margin-bottom: 4px;
  }
  .more-card h4 {
    font-family: 'Source Serif 4', serif;
    font-size: 15px;
    font-weight: 500;
    color: #1C1714;
    line-height: 1.3;
    margin-bottom: 4px;
  }
  .more-card .card-meta {
    font-size: 10px;
    color: #bbb;
  }

  /* ===== RESPONSIVE ===== */
  @media (max-width: 900px) {
    .article-layout {
      grid-template-columns: 1fr;
      gap: 0;
      padding: 24px 20px 0;
    }
    .article-sidebar {
      border-left: none;
      padding-left: 0;
      border-top: 2px solid #eee;
      padding-top: 32px;
      margin-top: 40px;
    }
    .more-grid {
      grid-template-columns: 1fr 1fr;
    }
  }
  @media (max-width: 768px) {
    .article-hero {
      height: 360px;
    }
    .hero-overlay {
      padding: 24px;
    }
    .hero-overlay h1 {
      font-size: 26px;
    }
    .article-meta-bar {
      flex-direction: column;
      gap: 12px;
      align-items: flex-start;
      padding: 16px 20px;
    }
    .article-layout {
      padding: 20px 16px 0;
    }
    .article-body p {
      font-size: 16px;
    }
    .info-grid {
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .more-articles {
      padding: 0 16px 40px;
    }
    .more-grid {
      grid-template-columns: 1fr;
      gap: 20px;
    }
    .ad-space {
      padding: 0 16px;
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
        <a href="/${cfg.folder}/${p.slug}/" class="grid-card article-card" data-type="${Array.isArray(p.recipeCategory) && p.recipeCategory.length > 0 ? p.recipeCategory.map(c => c.toLowerCase()).join(' ') : (p.postType || '').toLowerCase()}">
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
        const types = (card.dataset.type || '').split(' ');
        if (filter === 'all' || types.includes(filter)) {
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
    if (tagged.length > 0) {
      return tagged.sort((a, b) => {
        const aOrd = a.sortOrder ?? 9999;
        const bOrd = b.sortOrder ?? 9999;
        if (aOrd !== bOrd) return aOrd - bOrd;
        return new Date(b.date) - new Date(a.date);
      }).slice(0, 10);
    }
    return allPosts.filter(p => p.pillar === 'Cook').slice(0, 10);
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
    <div class="container">
      ${heroSection}
    </div>
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

  /* ---- Container ---- */
  .container {
    max-width: 1100px;
    margin: 0 auto;
    padding: 0 24px;
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
    font-family: 'Inter', sans-serif;
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
    font-family: 'Inter', sans-serif;
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
    font-family: 'Inter', sans-serif;
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
  .hero-label { font-family: 'Inter', sans-serif; font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--ember); margin-bottom: 16px; }
  .hero-inner h2 { font-family: 'Source Serif 4', serif; font-size: 26px; font-weight: 700; line-height: 1.15; margin-bottom: 16px; color: var(--ink); }
  .hero-excerpt { font-family: 'Inter', sans-serif; font-size: 15px; color: var(--gray-400, #999); line-height: 1.6; margin-bottom: 20px; }
  .hero-meta { font-family: 'Inter', sans-serif; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--gray-400, #999); }
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
    font-family: 'Inter', sans-serif;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ember, #B8432A);
    margin-bottom: 4px;
  }
  .eat-card h3 {
    font-family: 'Source Serif 4', serif;
    font-size: 16px;
    font-weight: 700;
    line-height: 1.3;
    margin-bottom: 4px;
    color: var(--ink, #1C1714);
  }
  .eat-card-excerpt {
    font-family: 'Inter', sans-serif;
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
    font-family: 'Inter', sans-serif;
    font-size: 12px;
    color: var(--gray-400, #999);
  }

  /* ===========================================================================
     3. FROM THE KITCHEN (dark band)
     =========================================================================== */
  .kitchen-band {
    background: var(--chestnut, #6B4C3B);
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
    font-family: 'Inter', sans-serif;
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
    font-family: 'Inter', sans-serif;
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
    font-family: 'Inter', sans-serif;
    font-size: 15px;
    color: var(--gray-400, #888);
    line-height: 1.65;
    margin-bottom: 10px;
  }
  .editors-pick-content time {
    font-family: 'Inter', sans-serif;
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
  // Fetch and write site alert JSON for BaseLayout to consume at build time
  console.log('Fetching site alert from Notion...');
  const siteAlert = await fetchActiveSiteAlert();
  const dataDir = path.resolve('src/data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'site-alert.json'),
    JSON.stringify(siteAlert || { active: false }, null, 2)
  );
  console.log(siteAlert?.active ? `Site alert active: "${siteAlert.message}"` : 'No active site alert.');

  console.log('Fetching active ads from Notion...');
  const activeAds = await fetchActiveAds();
  console.log(`Found ${activeAds.length} active ad(s).`);

  // Write ads.json so BaseLayout can render CMS-managed ad banners
  fs.writeFileSync(
    path.join(dataDir, 'ads.json'),
    JSON.stringify(activeAds, null, 2)
  );
  console.log(`Written: src/data/ads.json (${activeAds.length} ad(s))`);

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
    post.excerpt = post.excerpt || post.plainText.slice(0, 300);

    allPosts.push(post);
  }

  // -----------------------------------------------------------------------
  // 1. Generate individual article pages
  // -----------------------------------------------------------------------
  for (const post of allPosts) {
    const cfg = PILLAR_CONFIG[post.pillar];
    const dir = path.join(PAGES_DIR, cfg.folder, post.slug);
    fs.mkdirSync(dir, { recursive: true });

    const articlePage = generateArticlePage(post, post.bodyHtml, post.plainText, allPosts, activeAds);
    fs.writeFileSync(path.join(dir, 'index.astro'), articlePage);
    console.log(`  Written: src/pages/${cfg.folder}/${post.slug}/index.astro`);
  }

  // -----------------------------------------------------------------------
  // 2. Generate category listing pages
  //    SKIP if the existing file has mobile-only content (hand-built design)
  // -----------------------------------------------------------------------
  for (const [pillar, cfg] of Object.entries(PILLAR_CONFIG)) {
    const pillarPosts = allPosts.filter(p => p.pillar === pillar);
    const categoryPage = generateCategoryPage(pillar, pillarPosts);
    if (!categoryPage) continue;

    const dir = path.join(PAGES_DIR, cfg.folder);
    fs.mkdirSync(dir, { recursive: true });
    const catPath = path.join(dir, 'index.astro');
    if (fs.existsSync(catPath) && fs.readFileSync(catPath, 'utf-8').includes('mobile-only')) {
      console.log(`  SKIPPED: src/pages/${cfg.folder}/index.astro (has mobile layout - will not overwrite)`);
      continue;
    }
    fs.writeFileSync(catPath, categoryPage);
    console.log(`  Written: src/pages/${cfg.folder}/index.astro (${pillarPosts.length} posts)`);
  }

  // -----------------------------------------------------------------------
  // 3. Generate homepage
  //    SKIP if the existing file has mobile-only content (hand-built design)
  // -----------------------------------------------------------------------
  const homepagePath = path.join(PAGES_DIR, 'index.astro');
  if (fs.existsSync(homepagePath) && fs.readFileSync(homepagePath, 'utf-8').includes('mobile-only')) {
    console.log('  SKIPPED: src/pages/index.astro (has mobile layout - will not overwrite)');
  } else {
    if (fs.existsSync(homepagePath)) {
      fs.unlinkSync(homepagePath);
      console.log('  Deleted existing: src/pages/index.astro');
    }
    const homepageSrc = generateHomepage(allPosts);
    fs.writeFileSync(homepagePath, homepageSrc);
    console.log('  Written: src/pages/index.astro');
  }

  // -----------------------------------------------------------------------
  // 3a. Generate Travel sub-pages (Korea Guide theme pages)
  //     SKIP if existing file has guide-hero (hand-built design)
  // -----------------------------------------------------------------------
  const travelSubPages = {
    'Seoul Eats': 'seoul-eats',
    'Seoul Cafe': 'seoul-cafe',
    'Seoul Visit': 'seoul-visit',
    'Seoul Shops': 'seoul-shops',
    'Seoul Nights': 'seoul-nights',
  };
  const travelPosts = allPosts.filter(p => p.pillar === 'Travel');
  for (const [category, subSlug] of Object.entries(travelSubPages)) {
    const subDir = path.join(PAGES_DIR, 'travel', subSlug);
    const subPath = path.join(subDir, 'index.astro');
    if (fs.existsSync(subPath) && fs.readFileSync(subPath, 'utf-8').includes('guide-hero')) {
      console.log(`  SKIPPED: src/pages/travel/${subSlug}/index.astro (has hand-built design)`);
      continue;
    }
    // Only generate if we have posts for this category
    const postsInCat = travelPosts.filter(p =>
      Array.isArray(p.recipeCategory) && p.recipeCategory.includes(category)
    );
    console.log(`  Travel sub-page: ${category} (${postsInCat.length} posts) -> /travel/${subSlug}/`);
  }

  // -----------------------------------------------------------------------
  // 4. Generate Pantry page
  // -----------------------------------------------------------------------
  console.log('Fetching Pantry Items from Notion...');
  const pantryPages = await fetchPantryItems();
  console.log(`Found ${pantryPages.length} pantry item(s).`);
  const pantryItems = pantryPages.map(extractPantryItem);
  const pantryDir = path.join(PAGES_DIR, 'my-pantry');
  fs.mkdirSync(pantryDir, { recursive: true });
  const pantryPath = path.join(pantryDir, 'index.astro');
  if (fs.existsSync(pantryPath) && fs.readFileSync(pantryPath, 'utf-8').includes('mobile-only')) {
    console.log('  SKIPPED: src/pages/my-pantry/index.astro (has mobile layout - will not overwrite)');
  } else {
    fs.writeFileSync(pantryPath, generatePantryPage(pantryItems));
    console.log('  Written: src/pages/my-pantry/index.astro');
  }

  // -----------------------------------------------------------------------
  // 5. Generate search index
  // -----------------------------------------------------------------------
  const searchIndex = allPosts.map(p => ({
    title: p.title,
    pillar: p.pillar,
    postType: p.postType,
    slug: p.slug,
    date: p.date ? formatDate(p.date) : '',
    excerpt: (p.excerpt || '').substring(0, 200),
    coverUrl: p.coverUrl || '',
    url: `/${(p.pillar || 'eat').toLowerCase()}/${p.slug}/`,
    tags: p.recipeCategory || []
  }));
  const searchIndexPath = path.join(process.cwd(), 'public', 'search-index.json');
  fs.writeFileSync(searchIndexPath, JSON.stringify(searchIndex, null, 2));
  console.log(`  \u2705 Search index: ${searchIndex.length} entries \u2192 public/search-index.json`);

  console.log('Sync complete.');
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
