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
  const ad = ads.find(a => Array.isArray(a.placement) ? a.placement.includes(placement) : a.placement === placement);
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
      <iframe src="${embedUrl}" frameborder="0" scrolling="no" allowtransparency="true" style="border:none;overflow:hidden;width:100%;min-height:750px;"></iframe>
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
    tags: getProperty(page, 'Tags') || [],
    coverImages: getProperty(page, 'Cover Image') || [],
    videoThumbnail: getProperty(page, 'Video Thumbnail') || '',
    googleMapsUrl: getProperty(page, 'Google Maps URL') || '',
    excerpt: getProperty(page, 'Excerpt') || '',
  };

  // Resolve cover URL: 1) Cover Image file, 2) Video Thumbnail URL, 3) IG thumbnail download
  const igThumb = (data.coverImages[0] || data.videoThumbnail) ? null : await downloadIgThumbnail(data.videoUrl, data.slug);
  data.coverUrl = data.coverImages[0] || data.videoThumbnail || igThumb || '';

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
    const mapsQuery = encodeURIComponent(post.restaurantAddress);
    const mapsLink = post.googleMapsUrl || `https://maps.google.com/?q=${mapsQuery}`;
    restaurantInfo = `
      <div class="info-card restaurant-info">
        <h3>Restaurant Info</h3>
        <div class="restaurant-map">
          <iframe src="https://maps.google.com/maps?q=${mapsQuery}&t=&z=16&ie=UTF8&iwloc=&output=embed" width="100%" height="250" style="border:0;border-radius:8px;" allowfullscreen="" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
        </div>
        <div class="info-grid">
          ${post.restaurantAddress ? `<div class="info-item"><div class="info-label">Address</div><div class="info-value">${escapeHtml(post.restaurantAddress)}<a href="${mapsLink}" target="_blank" rel="noopener" class="directions-link">Get Directions &rarr;</a></div></div>` : ''}
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

  // Tags - merge Recipe Category and Tags fields, deduplicate
  const rc = Array.isArray(post.recipeCategory) ? post.recipeCategory : [];
  const tg = Array.isArray(post.tags) ? post.tags : [];
  const tagsArray = [...new Set([...rc, ...tg])];
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
    width: 100%;
    max-width: 540px;
    min-height: 750px;
    border-radius: 6px;
  }
  .restaurant-map {
    margin-bottom: 16px;
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

// Old design functions (generateCategoryPage, generateHomepage, generatePantryPage) permanently deleted.

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
  // 2-4. SKIPPED: Category pages, homepage, travel sub-pages, pantry page
  //      These are hand-built with the locked design system and must NEVER
  //      be overwritten by the sync. They consume search-index.json and
  //      ads.json at runtime via client-side JS.
  // -----------------------------------------------------------------------
  console.log('  Hand-built pages (homepage, category, pantry, travel) are never overwritten by sync.');

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
    tags: [...new Set([...(p.recipeCategory || []), ...(p.tags || [])])],
    homepagePosition: p.homepagePosition || ''
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
