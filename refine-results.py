#!/usr/bin/env python3
"""
refine-property-results.py — Property Scraper Results Refiner

Reads one or more property-scraper HTML result files, merges and deduplicates
listings, re-sorts by price ascending then floor area descending, calculates
price per sq ft with dynamic colour coding, optionally scores listings by
keywords, and groups high volume agents.

Usage:
    python refine-property-results.py
    python refine-property-results.py results-property-greenwich-2026-03-14.html
    python refine-property-results.py results-property-rightmove-*.html
"""

import sys
import os
import re
import glob
from datetime import datetime
from collections import defaultdict


# ─────────────────────────────────────────────
# PARSE HTML RESULTS FILES
# ─────────────────────────────────────────────

def parse_results_file(filepath):
    """Parse a property-scraper HTML results file and extract listings."""
    with open(filepath, 'r', encoding='utf-8') as f:
        html = f.read()

    properties = []

    # Extract each property card block
    # Cards are wrapped in <div style="margin:6px 0;padding:7px 11px;...">
    card_blocks = re.findall(
        r'<div style="margin:6px 0;padding:7px 11px[^"]*">(.*?)</div>\s*(?=<div style="margin:|<div style="margin-top:|</div>|$)',
        html, re.DOTALL
    )

    for block in card_blocks:
        # Skip SSTC and duplicate sections (reduced opacity cards)
        if 'opacity:0.45' in block or 'opacity: 0.45' in block:
            continue

        # Extract URL
        url_match = re.search(r'href="(https://(?:www\.rightmove\.co\.uk|www\.zoopla\.co\.uk)[^"]+)"', block)
        if not url_match:
            continue
        url = url_match.group(1)

        # Determine site
        site = 'Rightmove' if 'rightmove.co.uk' in url else 'Zoopla'

        # Extract address
        address_match = re.search(
            r'<a href="https://(?:www\.rightmove|www\.zoopla)[^"]*"[^>]*style="font-weight:600[^"]*"[^>]*>([^<]+)</a>',
            block
        )
        address = address_match.group(1).strip() if address_match else ''

        # Extract price display and numeric value
        price_match = re.search(r'<span style="font-weight:bold;color:#c0392b[^"]*">([^<]+)</span>', block)
        price_display = price_match.group(1).strip() if price_match else ''
        price_value = 0
        if price_display:
            nums = re.sub(r'[^0-9]', '', price_display)
            price_value = int(nums) if nums else 0

        # Extract floor area (sq ft) — look for digit pattern followed by sq ft
        floor_area_sqft = None
        area_match = re.search(r'📐\s*(~?[\d,]+)\s*sq\s*ft', block)
        if area_match:
            area_str = area_match.group(1).replace(',', '').replace('~', '')
            try:
                floor_area_sqft = int(area_str)
            except ValueError:
                pass

        # Extract bedrooms
        beds_match = re.search(r'🛏\s*([^\s·<]+)', block)
        bedrooms = beds_match.group(1).strip() if beds_match else ''

        # Extract bathrooms
        baths_match = re.search(r'🚿\s*([^\s·<]+)', block)
        bathrooms = baths_match.group(1).strip() if baths_match else ''

        # Extract reception (Zoopla)
        recep_match = re.search(r'🛋\s*([^\s·<]+)', block)
        reception = recep_match.group(1).strip() if recep_match else ''

        # Extract property type — text between last · and closing div of detail row
        type_match = re.search(r'·\s*</span>\s*([A-Z][^·<\n]+?)(?:\s*&nbsp;|<span|</div>)', block)
        property_type = type_match.group(1).strip() if type_match else ''

        # Extract agent
        agent_match = re.search(r'<span>([^<]+)</span>\s*(?:<span[^>]*>📞|<span[^>]*>📞|<a href)', block)
        agent = agent_match.group(1).strip() if agent_match else ''

        # Extract added date
        date_match = re.search(r'<span style="margin-left:10px;">([^<]*(?:Added|Reduced|just)[^<]*)</span>', block, re.IGNORECASE)
        added_date = date_match.group(1).strip() if date_match else ''

        # Extract tags (pill spans)
        tags = re.findall(r'<span style="background:#eaf4fb[^"]*">([^<]+)</span>', block)

        # Detect badges
        no_chain = 'NO CHAIN' in block
        is_sstc = 'SSTC' in block
        is_seen = 'SEEN BEFORE' in block
        is_dup = 'DUPLICATE' in block
        is_reduced = 'reduced' in [t.lower() for t in tags] or 'Reduced' in block

        # Generate a dedup key — address normalised + price
        dedup_key = f"{re.sub(r'[^a-z0-9]', '', address.lower())}||{price_value}"

        properties.append({
            'url': url,
            'site': site,
            'address': address,
            'price_display': price_display,
            'price_value': price_value,
            'floor_area_sqft': floor_area_sqft,
            'bedrooms': bedrooms,
            'bathrooms': bathrooms,
            'reception': reception,
            'property_type': property_type,
            'agent': agent,
            'added_date': added_date,
            'tags': tags,
            'no_chain': no_chain,
            'is_sstc': is_sstc,
            'is_seen': is_seen,
            'is_dup': is_dup,
            'is_reduced': is_reduced,
            'dedup_key': dedup_key,
            'source_file': filepath,
            'score': 0,
            'score_reasons': [],
        })

    return properties


# ─────────────────────────────────────────────
# MERGE AND DEDUPLICATE
# ─────────────────────────────────────────────

def merge_properties(all_properties):
    """Deduplicate by address+price across multiple files."""
    seen_keys = {}
    merged = []
    for p in all_properties:
        key = p['dedup_key']
        if key not in seen_keys:
            seen_keys[key] = True
            merged.append(p)
    return merged


# ─────────────────────────────────────────────
# KEYWORD SCORING
# ─────────────────────────────────────────────

def score_properties(properties, boost_keywords, penalise_keywords):
    """Score each property based on keyword matches in address, type and tags."""
    for p in properties:
        searchable = ' '.join([
            p['address'].lower(),
            p['property_type'].lower(),
            p['agent'].lower(),
            ' '.join(t.lower() for t in p['tags']),
        ])
        score = 0
        reasons = []
        for kw in boost_keywords:
            if kw.lower() in searchable:
                score += 1
                reasons.append(f'+{kw}')
        for kw in penalise_keywords:
            if kw.lower() in searchable:
                score -= 1
                reasons.append(f'-{kw}')
        p['score'] = score
        p['score_reasons'] = reasons
    return properties


# ─────────────────────────────────────────────
# PRICE PER SQ FT — DYNAMIC THIRDS
# ─────────────────────────────────────────────

def calculate_ppsf(properties):
    """
    Calculate price per sq ft for each listing and assign colour tier
    based on dynamic thirds of the distribution.
    Returns (properties, avg_ppsf, count_with_data, count_without_data).
    """
    ppsf_values = []
    for p in properties:
        if p['floor_area_sqft'] and p['price_value'] > 0:
            ppsf = round(p['price_value'] / p['floor_area_sqft'])
            p['ppsf'] = ppsf
            ppsf_values.append(ppsf)
        else:
            p['ppsf'] = None

    count_with = len(ppsf_values)
    count_without = len(properties) - count_with

    if count_with < 2:
        # Not enough data for meaningful thirds
        for p in properties:
            p['ppsf_tier'] = None
        avg_ppsf = ppsf_values[0] if ppsf_values else None
        return properties, avg_ppsf, count_with, count_without

    avg_ppsf = round(sum(ppsf_values) / count_with)
    sorted_vals = sorted(ppsf_values)
    n = len(sorted_vals)
    lower_third = sorted_vals[n // 3]
    upper_third = sorted_vals[(2 * n) // 3]

    for p in properties:
        if p['ppsf'] is None:
            p['ppsf_tier'] = None
        elif p['ppsf'] <= lower_third:
            p['ppsf_tier'] = 'green'   # best value
        elif p['ppsf'] <= upper_third:
            p['ppsf_tier'] = 'amber'   # mid
        else:
            p['ppsf_tier'] = 'red'     # most expensive per sq ft

    return properties, avg_ppsf, count_with, count_without


# ─────────────────────────────────────────────
# HIGH VOLUME AGENT DETECTION
# ─────────────────────────────────────────────

MIN_HIGH_VOLUME_THRESHOLD = 3  # never flag agents with fewer than this many listings

def detect_high_volume_agents(properties):
    """
    Dynamically detect high volume agents using mean + 1 standard deviation
    of listing counts per agent. Agents above the threshold are grouped separately.
    Minimum threshold of MIN_HIGH_VOLUME_THRESHOLD prevents false positives in
    small result sets.
    Returns (clean_properties, high_volume_groups, threshold_used).
    """
    import math

    agent_counts = defaultdict(int)
    for p in properties:
        if p['agent']:
            agent_counts[p['agent'].strip()] += 1

    if not agent_counts:
        return properties, [], 0

    counts = list(agent_counts.values())
    mean = sum(counts) / len(counts)
    variance = sum((c - mean) ** 2 for c in counts) / len(counts)
    std_dev = math.sqrt(variance)

    # Threshold = mean + 1 std dev, with a minimum floor
    threshold = max(MIN_HIGH_VOLUME_THRESHOLD, math.ceil(mean + std_dev))

    hv_agents = {a for a, c in agent_counts.items() if c >= threshold}

    if not hv_agents:
        return properties, [], threshold

    clean = [p for p in properties if p['agent'].strip() not in hv_agents]
    pulled = [p for p in properties if p['agent'].strip() in hv_agents]

    groups = defaultdict(list)
    for p in pulled:
        groups[p['agent'].strip()].append(p)

    hv_groups = sorted(groups.items(), key=lambda x: (-len(x[1]), x[0].lower()))
    return clean, hv_groups, threshold


# ─────────────────────────────────────────────
# SORT
# ─────────────────────────────────────────────

def sort_properties(properties):
    """
    Sort by price ascending, then floor area descending as tiebreaker.
    Listings with no price (0) go to end.
    Listings with no floor area go after those that have it at same price.
    """
    return sorted(properties, key=lambda p: (
        p['price_value'] if p['price_value'] > 0 else 999_999_999,
        -(p['floor_area_sqft'] or 0),
    ))


# ─────────────────────────────────────────────
# CLASSIFY INTO SECTIONS
# ─────────────────────────────────────────────

def classify(properties):
    """Split into no chain, main, sstc, dup/seen sections."""
    no_chain = []
    main = []
    sstc = []
    other = []

    for p in properties:
        if p['is_dup'] or p['is_seen']:
            other.append(p)
        elif p['no_chain'] and not p['is_sstc']:
            no_chain.append(p)
        elif p['is_sstc']:
            sstc.append(p)
        else:
            main.append(p)

    return no_chain, main, sstc, other


# ─────────────────────────────────────────────
# HTML REPORT
# ─────────────────────────────────────────────

SITE_COLOURS = {
    'Rightmove': '#004f9f',
    'Zoopla':    '#7b2d8b',
}

PPSF_STYLES = {
    'green': ('background:#e8f8f0;color:#0f6e56;', 'best value / sq ft'),
    'amber': ('background:#fef9ec;color:#ba7517;', 'mid range / sq ft'),
    'red':   ('background:#fdecea;color:#a32d2d;', 'most expensive / sq ft'),
}

SCORE_STYLES = {
    'pos': 'background:#e8f8f0;color:#0f6e56;',
    'neg': 'background:#fdecea;color:#a32d2d;',
}


def render_card(p, index, using_keywords):
    site_colour = SITE_COLOURS.get(p['site'], '#555')
    opacity = '0.5' if (p['is_seen'] or p['is_dup'] or p['score'] < 0) else '1'

    # Badges row
    badges = f'<a href="{p["url"]}" style="background:{site_colour};color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;text-decoration:none;margin-right:5px;">{p["site"]}</a>'

    if p['no_chain']:
        badges += '<span style="background:#27ae60;color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;margin-right:5px;">NO CHAIN</span>'
    if p['is_sstc']:
        badges += '<span style="background:#95a5a6;color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;margin-right:5px;">SSTC</span>'
    if p['is_seen']:
        badges += '<span style="background:#e67e22;color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;margin-right:5px;">SEEN BEFORE</span>'
    if p['is_dup']:
        badges += '<span style="background:#8e44ad;color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;margin-right:5px;">DUPLICATE</span>'

    # Keyword score badge — only shown if keywords were entered
    if using_keywords and p['score'] != 0:
        score_label = f'+{p["score"]}' if p['score'] > 0 else str(p['score'])
        score_style = SCORE_STYLES['pos'] if p['score'] > 0 else SCORE_STYLES['neg']
        badges += f'<span style="{score_style}padding:2px 7px;border-radius:4px;font-size:11px;margin-right:5px;font-weight:500;">{score_label}</span>'

    # Detail row
    detail_parts = []
    if p['bedrooms']:    detail_parts.append(f'🛏 {p["bedrooms"]}')
    if p['bathrooms']:   detail_parts.append(f'🚿 {p["bathrooms"]}')
    if p['reception']:   detail_parts.append(f'🛋 {p["reception"]}')
    if p['floor_area_sqft']:
        detail_parts.append(f'📐 {p["floor_area_sqft"]:,} sq ft')
    if p['property_type']:
        detail_parts.append(p['property_type'])
    for tag in p['tags']:
        detail_parts.append(f'<span style="background:#eaf4fb;color:#185fa5;padding:1px 5px;border-radius:3px;font-size:11px;">{tag}</span>')

    detail_html = ' &nbsp;·&nbsp; '.join(detail_parts) if detail_parts else ''

    # Price per sq ft badge
    ppsf_html = ''
    if p['ppsf'] is not None and p['ppsf_tier']:
        style, title = PPSF_STYLES[p['ppsf_tier']]
        ppsf_html = f'<span style="{style}padding:1px 7px;border-radius:4px;font-size:11px;font-weight:500;" title="{title}">£{p["ppsf"]:,} / sq ft</span>'

    return f'''
      <div style="margin:6px 0;padding:7px 11px;border:1px solid #eee;border-radius:5px;opacity:{opacity};line-height:1.4;">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
          <span style="color:#999;font-size:0.8rem;">{index}.</span>
          {badges}
          <a href="{p['url']}" style="font-weight:600;font-size:0.95rem;color:#1a1a1a;text-decoration:none;"
             onmouseover="this.style.textDecoration='underline'"
             onmouseout="this.style.textDecoration='none'">{p['address'] or '(no address)'}</a>
          <span style="font-weight:bold;color:#c0392b;font-size:0.95rem;white-space:nowrap;">{p['price_display'] or 'POA'}</span>
        </div>
        {f'<div style="color:#666;font-size:0.8rem;margin-top:2px;">{detail_html}</div>' if detail_html else ''}
        <div style="color:#999;font-size:0.75rem;margin-top:3px;display:flex;flex-wrap:wrap;align-items:center;gap:6px;">
          {ppsf_html}
          {f'<span>{p["agent"]}</span>' if p['agent'] else ''}
          {f'<span>{p["added_date"]}</span>' if p['added_date'] else ''}
          <a href="{p['url']}" style="color:#2980b9;font-size:0.75rem;">{p["url"]}</a>
        </div>
      </div>'''


def render_section(properties, heading, border_colour, index_start, using_keywords, opacity='1'):
    if not properties:
        return '', index_start
    cards = ''
    idx = index_start
    for p in properties:
        cards += render_card(p, idx, using_keywords)
        idx += 1
    count = len(properties)
    section = f'''
      <div style="margin-top:1.75rem;">
        <h3 style="border-bottom:2px solid {border_colour};padding-bottom:0.4rem;margin-bottom:0.5rem;opacity:{opacity};">{heading}</h3>
        <p style="color:#888;font-size:0.8rem;margin-bottom:0.5rem;">{count} listing{"s" if count != 1 else ""}</p>
        {cards}
      </div>'''
    return section, idx


def generate_report(
    no_chain, main, sstc, other, hv_groups,
    avg_ppsf, count_with_ppsf, count_without_ppsf,
    source_files, boost_keywords, penalise_keywords,
    total_count, hv_threshold=3,
):
    today = datetime.now().strftime('%d/%m/%Y')
    using_keywords = bool(boost_keywords or penalise_keywords)
    source_names = ', '.join(os.path.basename(f) for f in source_files)
    active_count = len(no_chain) + len(main)
    hv_count = sum(len(jobs) for _, jobs in hv_groups) if hv_groups else 0

    # PPSF header note
    ppsf_note = ''
    if avg_ppsf:
        ppsf_note = (
            f'&middot; avg <strong>£{avg_ppsf:,} / sq ft</strong> '
            f'&middot; <span style="color:#888;">calculated from {count_with_ppsf} of {total_count} listings'
            f'{f" &middot; {count_without_ppsf} had no floor area data" if count_without_ppsf else ""}'
            f'</span> '
        )

    # Keyword summary
    kw_note = ''
    if using_keywords:
        parts = []
        if boost_keywords:
            parts.append(f'boosting: <em>{", ".join(boost_keywords)}</em>')
        if penalise_keywords:
            parts.append(f'penalising: <em>{", ".join(penalise_keywords)}</em>')
        kw_note = f'&middot; keywords: {" · ".join(parts)} '

    # Legend
    legend_parts = [
        '<a href="#" style="background:#004f9f;color:#fff;padding:1px 5px;border-radius:3px;text-decoration:none;">Rightmove</a>',
        '<a href="#" style="background:#7b2d8b;color:#fff;padding:1px 5px;border-radius:3px;text-decoration:none;margin-left:4px;">Zoopla</a>',
        '&nbsp;= source site',
        '<span style="background:#27ae60;color:#fff;padding:1px 5px;border-radius:3px;">NO CHAIN</span> = no onward chain',
        '<span style="background:#95a5a6;color:#fff;padding:1px 5px;border-radius:3px;">SSTC</span> = under offer / sold STC',
        '<span style="background:#e67e22;color:#fff;padding:1px 5px;border-radius:3px;">SEEN BEFORE</span> = previous run',
    ]
    if avg_ppsf:
        legend_parts += [
            '<span style="background:#e8f8f0;color:#0f6e56;padding:1px 5px;border-radius:3px;">£X / sq ft</span> = best value third',
            '<span style="background:#fef9ec;color:#ba7517;padding:1px 5px;border-radius:3px;">£X / sq ft</span> = mid range',
            '<span style="background:#fdecea;color:#a32d2d;padding:1px 5px;border-radius:3px;">£X / sq ft</span> = most expensive third',
        ]
    if using_keywords:
        legend_parts += [
            '<span style="background:#e8f8f0;color:#0f6e56;padding:1px 5px;border-radius:3px;">+N</span> = keyword score boost',
            '<span style="background:#fdecea;color:#a32d2d;padding:1px 5px;border-radius:3px;">−N</span> = keyword score penalised',
        ]
    legend_html = ' &nbsp;·&nbsp; '.join(legend_parts)

    # Build sections
    sections = ''
    idx = 1

    s, idx = render_section(no_chain, '⛓️ No Chain', '#27ae60', idx, using_keywords)
    sections += s

    if main:
        cards = ''
        for p in main:
            cards += render_card(p, idx, using_keywords)
            idx += 1
        sections += f'''
      <div style="margin-top:1.75rem;">
        <p style="color:#888;font-size:0.8rem;margin-bottom:0.5rem;">{len(main)} listing{"s" if len(main) != 1 else ""}</p>
        {cards}
      </div>'''

    s, idx = render_section(sstc, 'Under Offer / Sold STC', '#95a5a6', idx, using_keywords, opacity='0.45')
    sections += s

    s, idx = render_section(other, 'Seen Before / Duplicates', '#8e44ad', idx, using_keywords, opacity='0.45')
    sections += s

    # High volume agents
    if hv_groups:
        hv_cards = ''
        for agent, props in hv_groups:
            props_sorted = sort_properties(props)
            hv_cards += f'<div style="margin-top:1.25rem;"><p style="font-weight:600;font-size:0.85rem;margin-bottom:4px;">{agent} <span style="color:#999;font-weight:normal;">— {len(props)} listing{"s" if len(props) != 1 else ""}</span></p>'
            for p in props_sorted:
                hv_cards += render_card(p, idx, using_keywords)
                idx += 1
            hv_cards += '</div>'

        sections += f'''
      <div style="margin-top:1.75rem;opacity:0.6;">
        <h3 style="border-bottom:2px solid #bbb;padding-bottom:0.4rem;margin-bottom:0.5rem;color:#888;">
          📋 High volume agents — {hv_threshold}+ listings (dynamic threshold)
        </h3>
        <p style="color:#888;font-size:0.8rem;margin-bottom:0.5rem;">
          {hv_count} listing{"s" if hv_count != 1 else ""} from {len(hv_groups)} agent{"s" if len(hv_groups) != 1 else ""} —
          {" · ".join(f"{a} ({len(ps)})" for a, ps in hv_groups)}
        </p>
        {hv_cards}
      </div>'''

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Property Results — Refined</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 960px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.5; }}
    h1 {{ font-size: 1.5rem; margin-bottom: 0.25rem; }}
    h3 {{ font-size: 1rem; margin-bottom: 0.25rem; }}
    a {{ color: #2980b9; }}
  </style>
</head>
<body>
  <h1>Property Results — Refined</h1>
  <p style="color:#666;font-size:0.85rem;">
    {today} &middot; {total_count} propert{"ies" if total_count != 1 else "y"} from {len(source_files)} file{"s" if len(source_files) != 1 else ""}
    &middot; {active_count} active
    {f'&middot; <strong style="color:#27ae60;">{len(no_chain)} no chain</strong>' if no_chain else ''}
    {f'&middot; <span style="color:#95a5a6;">{len(sstc)} SSTC</span>' if sstc else ''}
    {f'&middot; <span style="color:#8e44ad;">{len(other)} seen/dup</span>' if other else ''}
    {f'&middot; <span style="color:#888;">{hv_count} high volume agent{"s" if hv_count != 1 else ""}</span>' if hv_count else ''}
    &middot; sorted by price ↑ then floor area ↓
  </p>
  <p style="color:#666;font-size:0.85rem;">
    {ppsf_note}{kw_note}
    Sources: {source_names}
  </p>
  <p style="font-size:0.8rem;color:#888;margin-top:0.75rem;">{legend_html}</p>
  <hr style="margin:1.5rem 0;border:none;border-top:1px solid #eee;">
  {sections or '<p style="color:#888;">No properties found.</p>'}
</body>
</html>'''


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────

def main():
    print('\n  property-scraper — Results Refiner\n')

    # ── Step 1: File selection ──
    if len(sys.argv) > 1:
        files = sys.argv[1:]
        missing = [f for f in files if not os.path.exists(f)]
        if missing:
            print(f'  ⚠  File(s) not found: {", ".join(missing)}')
            sys.exit(1)
    else:
        files = sorted([
            f for f in glob.glob('results-property-*.html')
            if 'refined' not in f
        ])
        if not files:
            print('  No results-property-*.html files found in current directory.')
            print('  Run from the same folder as your results files, or pass file paths as arguments.')
            sys.exit(1)

        print(f'  Found {len(files)} results file(s):')
        for f in files:
            print(f'    - {f}')

        answer = input('\n  Load these files? (y/n): ').strip().lower()
        if answer != 'y':
            raw = input('  Enter file paths separated by spaces: ').strip()
            files = [f.strip().strip('"\'') for f in raw.split() if f.strip()]
            missing = [f for f in files if not os.path.exists(f)]
            if missing:
                print(f'  ⚠  File(s) not found: {", ".join(missing)}')
                sys.exit(1)

    # ── Step 2: Parse ──
    print('\n  Parsing files...')
    all_properties = []
    for filepath in files:
        props = parse_results_file(filepath)
        print(f'  ✓  {os.path.basename(filepath)} — {len(props)} listings')
        all_properties.extend(props)

    if not all_properties:
        print('\n  ⚠  No listings found. The HTML format may not match — check the file.')
        sys.exit(1)

    # ── Step 3: Merge and deduplicate ──
    merged = merge_properties(all_properties)
    print(f'\n  {len(merged)} unique listings after deduplication')

    # ── Step 4: Keywords ──
    print('\n  Keywords — scanned against address, property type, agent, and tags.')
    print('  Fields available: address text, property type (e.g. Flat, Terraced),')
    print('  agent name, tags (e.g. freehold, reduced, new home, parking, garden)\n')

    boost_input = input('  Boost keywords (comma separated, or Enter to skip): ').strip()
    boost_keywords = [k.strip().lower() for k in boost_input.split(',') if k.strip()] if boost_input else []

    penalise_input = input('  Penalise keywords (comma separated, or Enter to skip): ').strip()
    penalise_keywords = [k.strip().lower() for k in penalise_input.split(',') if k.strip()] if penalise_input else []

    if boost_keywords or penalise_keywords:
        merged = score_properties(merged, boost_keywords, penalise_keywords)
        boosted = sum(1 for p in merged if p['score'] > 0)
        penalised = sum(1 for p in merged if p['score'] < 0)
        print(f'\n  ✓  Scored — {boosted} boosted, {penalised} penalised')
    else:
        print('  Skipping keyword scoring.')

    # ── Step 5: Price per sq ft ──
    merged, avg_ppsf, count_with_ppsf, count_without_ppsf = calculate_ppsf(merged)
    if avg_ppsf:
        print(f'\n  ✓  Price per sq ft — avg £{avg_ppsf:,} from {count_with_ppsf} listings ({count_without_ppsf} had no data)')
    else:
        print('\n  ⚠  Not enough floor area data for price per sq ft calculation.')

    # ── Step 6: Sort ──
    merged = sort_properties(merged)

    # ── Step 7: Classify into sections ──
    no_chain, main, sstc, other = classify(merged)

    # ── Step 8: High volume agents (from active listings only) ──
    active = no_chain + main
    active_clean, hv_groups, hv_threshold = detect_high_volume_agents(active)

    # Re-split clean active listings back into no chain / main
    no_chain_clean = [p for p in active_clean if p['no_chain'] and not p['is_sstc']]
    main_clean = [p for p in active_clean if not p['no_chain'] and not p['is_sstc']]

    if hv_groups:
        hv_total = sum(len(ps) for _, ps in hv_groups)
        print(f'  ✓  High volume agents (threshold: {hv_threshold}+) — {hv_total} listings from {len(hv_groups)} agent(s) grouped separately:')
        for agent, props in hv_groups:
            print(f'       {agent}: {len(props)} listings')

    # ── Step 9: Generate report ──
    total_count = len(merged)
    html = generate_report(
        no_chain_clean, main_clean, sstc, other, hv_groups,
        avg_ppsf, count_with_ppsf, count_without_ppsf,
        files, boost_keywords, penalise_keywords,
        total_count, hv_threshold,
    )

    date_str = datetime.now().strftime('%Y-%m-%d')
    outfile = f'results-property-refined-{date_str}.html'
    with open(outfile, 'w', encoding='utf-8') as f:
        f.write(html)

    active_final = len(no_chain_clean) + len(main_clean)
    print(f'\n  ✓  Report saved to {outfile}')
    print(f'  🏠 {total_count} properties · {active_final} active · {len(sstc)} SSTC · {len(other)} seen/dup')
    if hv_groups:
        print(f'  📋 {sum(len(ps) for _, ps in hv_groups)} high volume agent listings grouped separately')
    print()


if __name__ == '__main__':
    main()
