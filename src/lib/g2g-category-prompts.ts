// ─────────────────────────────────────────────────────────────────────────────
// G2G Category Prompt Templates
// Derived from: G2G PROMPT - MASTER LIST.docx
// Each category has: URL pattern, H1/H2 structure, writing rules, keyword rules
// Used by /api/brief/generate to tailor content drafts per category type
// ─────────────────────────────────────────────────────────────────────────────

export interface CategoryTemplate {
  category: string
  icon: string
  urlPatterns: string[]      // URL fragments that identify this category
  h1Template: string         // HTML H1 template (use {mainKeyword})
  sections: {
    subheading: string       // H2 template
    instructions: string     // What to write in this section
  }[]
  keywordRules: string
  writingRules: string
  faqFocus: string
  metaTitleTemplate: string
  metaDescriptionGuide: string
}

export const CATEGORY_TEMPLATES: CategoryTemplate[] = [
  // ── 🎮 Accounts ─────────────────────────────────────────────────────────────
  {
    category: 'Game Accounts',
    icon: '🎮',
    urlPatterns: ['account', 'accounts'],
    h1Template: 'Buy {mainKeyword} - Fast Delivery, 24/7 Support | G2G.com',
    sections: [
      {
        subheading: 'Buy {mainKeyword} — What You Can Achieve',
        instructions: '~250 words, 3+ paragraphs. Explain what players can achieve with these accounts: unlocking levels, skipping grind, accessing rare gear. Highlight buyer intent: convenience, premium access, instant gameplay boost. Integrate semantic keywords naturally.',
      },
      {
        subheading: 'Why You Should Buy {mainKeyword} on G2G',
        instructions: '3 paragraphs covering: (1) GamerProtect — escrow protects buyers & sellers, ISO/IEC 27001:2013 certified. (2) Verified sellers, 200+ payment methods, 24/7 support, G2G buyer protection even post-72hr window. (3) Transparent ratings and reviews.',
      },
      {
        subheading: 'How to Buy {mainKeyword} on G2G',
        instructions: 'Use ordered list: 1. Log in or sign up. 2. Search for the game + account category. 3. Browse listings, check seller ratings. 4. Chat with seller to confirm. 5. Click Buy Now, agree to terms, add notes. 6. Pay with 200+ payment methods. 7. Verify receipt and mark as Delivered.',
      },
      {
        subheading: 'About {gameName}',
        instructions: '~250 words, 3 paragraphs. Summarize the game world/gameplay. Why it\'s popular or challenging. Why having a higher-level account improves gameplay.',
      },
      {
        subheading: 'Trending Products',
        instructions: '{{trending_games}} — just include this placeholder, do not change it.',
      },
      {
        subheading: 'FAQ',
        instructions: '3–5 FAQs based on People Also Ask. Focus on: transaction safety (escrow, GamerProtect, verified sellers), delivery process and timing, refund/dispute policy, seller verification.',
      },
    ],
    keywordRules: 'Main keyword: 1%–7% density. Secondary keywords: under 2%, include each at least once, no exception.',
    writingRules: 'Do not bold keywords. Avoid redundant content. Include entity-focused gamer-centric language. Expand game-specific details (mechanics, roles, playstyles, items). Use <br><br> between paragraphs (no <p> tags). Forbidden words: immerse yourself, step into, dive into, forge, embark, captivating, delve into, buckle up, unravel, thrill. Never mention game publishers, developers, or competing marketplaces.',
    faqFocus: 'Transaction safety, escrow, GamerProtect, delivery, refunds, seller verification',
    metaTitleTemplate: 'Buy {mainKeyword} - G2G.com (≤60 chars)',
    metaDescriptionGuide: '≤110 chars. Include gameplay/buying benefit + 3 trust terms from: Reliable, fast process, secure, seamless, 24/7 support, GamerProtect.',
  },

  // ── 🪙 Game Coins / Currency ─────────────────────────────────────────────────
  {
    category: 'Game Coins / Currency',
    icon: '🪙',
    urlPatterns: ['coins', 'currency', 'gold', 'credits', 'gems', 'tokens'],
    h1Template: 'Buy {mainKeyword} - Fast Delivery, 24/7 Support | G2G.com',
    sections: [
      {
        subheading: 'Buy {mainKeyword} — Unlock Your Gameplay',
        instructions: '~250 words, 3+ paragraphs. What players can achieve with the currency (unlock gear, skip grind, faster progress). Why it matters for gameplay or competition. Integrate semantic keywords naturally.',
      },
      {
        subheading: 'Why You Should Buy {mainKeyword} on G2G',
        instructions: '3 paragraphs: (1) GamerProtect escrow system — protects buyers and sellers. (2) ISO-certified security, verified sellers, 200+ payment options. (3) 24/7 customer support and transparent ratings. G2G protects buyers even after 72-hour window.',
      },
      {
        subheading: 'How to Buy {mainKeyword} on G2G',
        instructions: 'Ordered list steps: 1. Log in/sign up. 2. Search game name in search bar, select Game Coins category. 3. Browse listings, check seller ratings, delivery speed, reviews. 4. Chat with seller if needed. 5. Click Buy Now, agree terms, add notes. 6. Pay with 200+ methods. 7. Verify coins, mark as Delivered.',
      },
      {
        subheading: 'About {gameName}',
        instructions: '~250 words, 3 paragraphs. Summarize game world/gameplay. Why it\'s popular or challenging. Why having extra currency improves gameplay.',
      },
      {
        subheading: 'Trending Products',
        instructions: '{{trending_games}} — just include this placeholder.',
      },
      {
        subheading: 'FAQ',
        instructions: '3–5 FAQs from PAA. Focus on: transaction safety, delivery process/timing, refund/dispute policy, seller verification, buyer support.',
      },
    ],
    keywordRules: 'Main keyword: 1%–4% density. Secondary keywords: ≤2%, appear at least once, no exception.',
    writingRules: 'Natural, helpful tone. Gamer and buyer-centric language. Include GamerProtect, escrow, verified sellers, ISO/IEC 27001:2013, 200+ payment methods, 24/7 support. Use <br><br>. Avoid: immersive, embark, dive into, similar filler. Never mention publishers, developers, competing marketplaces.',
    faqFocus: 'Transaction safety, escrow, delivery, refunds, seller verification',
    metaTitleTemplate: 'Buy {mainKeyword} - G2G.com (≤60 chars)',
    metaDescriptionGuide: '≤110 chars. Gameplay/buying benefit + 3 trust terms.',
  },

  // ── 🎇 Boosting ──────────────────────────────────────────────────────────────
  {
    category: 'Boosting / Power Leveling',
    icon: '🎇',
    urlPatterns: ['boosting', 'boost', 'power-level', 'powerleveling', 'rank-boost'],
    h1Template: '{mainKeyword} - Trusted & 24/7 Support | G2G.com',
    sections: [
      {
        subheading: '{mainKeyword} — Save Time, Climb Ranks',
        instructions: '≤250 words, 3 paragraphs. Focus on player challenges (not enough time, slow progress, competitive frustration). Explain how boosting saves time, improves ranks, unlocks rewards. Conversational but professional.',
      },
      {
        subheading: 'Why You Should Buy {gameName} Boosting on G2G',
        instructions: '3 paragraphs: GamerProtect (escrow protects buyers and sellers), ISO-certified security + verified sellers + 200+ payment options, 24/7 support + transparent ratings. G2G protects buyers even after order completion.',
      },
      {
        subheading: 'How To Buy {mainKeyword} on G2G',
        instructions: 'Ordered list: 1. Log in/sign up. 2. Search game > Boosting Service. 3. Review sellers, check ratings. 4. Read seller description or chat. 5. Click Buy Now, check agreement box, add notes. 6. Pay using 200+ payment options. 7. After service complete, confirm satisfaction and mark as Delivered.',
      },
      {
        subheading: 'About {gameName}',
        instructions: '≤250 words, 3 paragraphs. Describe gameplay, main mechanics, popular modes. Why players love it. Why boosting is beneficial (competitive ladder, grind-heavy progression, exclusive unlocks).',
      },
      {
        subheading: 'Trending Products',
        instructions: '{{trending_games}} — placeholder only.',
      },
      {
        subheading: 'FAQ',
        instructions: '3–5 FAQs from PAA. Focus on trust and buyer safety (transaction protection, verified sellers, refunds). Avoid topics about sharing IDs, logins, redemption.',
      },
    ],
    keywordRules: 'Main keyword: 1%–7%. Secondary keywords: ≤3%, both keywords natural across headings and paragraphs.',
    writingRules: 'Short, clear, structured sentences. <br><br> not <p> tags. No redundancy or jargon. Forbidden: immerse yourself, step into, dive into, forge, embark, captivating, delve into, buckle up, unravel. No developers, publishers, competing marketplaces. Use gamer-centric terms (ranks, skills, progression, currencies, modes).',
    faqFocus: 'Trust, buyer safety, transaction protection, refunds, service completion process',
    metaTitleTemplate: '{gameName} Boosting Service - G2G.com Secure Marketplace (≤60 chars)',
    metaDescriptionGuide: '≤110 chars. Include 3 of: Reliable, 24/7 support, seamless process, secure marketplace, fast delivery, GamerProtect.',
  },

  // ── 🫂 GamePal / LFG ─────────────────────────────────────────────────────────
  {
    category: 'GamePal / LFG',
    icon: '🫂',
    urlPatterns: ['gamepal', 'lfg', 'companion', 'play-with'],
    h1Template: '{mainKeyword} - Trusted & 24/7 Support | G2G.com',
    sections: [
      {
        subheading: '{mainKeyword} — Find Your Perfect Gaming Companion',
        instructions: '≤250 words. Address player frustrations: slow progression, playing alone, limited time, difficulty finding skilled partners. Explain how GamePal helps — efficiently, safely, fun. Highlight: built-in video call, calendar booking, profile reviews (stars + comments), optional tips after service.',
      },
      {
        subheading: 'Why You Should Use {gameName} GamePal on G2G',
        instructions: '3 paragraphs on GamerProtect, ISO security, verified GamePals, 200+ payment methods, 24/7 support, transparent ratings.',
      },
      {
        subheading: 'How To Book a {mainKeyword} on G2G',
        instructions: 'Ordered list covering: sign in, search, browse GamePal profiles, check reviews/ratings/video call availability, book, pay, complete session, rate.',
      },
      {
        subheading: 'About {gameName}',
        instructions: '≤250 words. Game overview, why it\'s social, why having a skilled companion improves experience.',
      },
      { subheading: 'Trending Products', instructions: '{{trending_games}}' },
      { subheading: 'FAQ', instructions: '3–5 FAQs. Focus on how GamePal works, safety, cancellation, tipping, what\'s included.' },
    ],
    keywordRules: 'Main keyword: 1%–7%. Secondary keywords: ≤3%.',
    writingRules: 'Friendly, fun, gamer-centric. Highlight GamePal unique features (video call, booking calendar, reviews). <br><br>. No forbidden words. No competitors or publishers.',
    faqFocus: 'How GamePal works, safety, cancellation, tipping, video call feature',
    metaTitleTemplate: '{gameName} GamePal - G2G.com (≤60 chars)',
    metaDescriptionGuide: '≤110 chars. Emphasize companion, fun, safety.',
  },

  // ── 🔑 Games/Key / CD-Key ────────────────────────────────────────────────────
  {
    category: 'Game Keys / CD Keys',
    icon: '🔑',
    urlPatterns: ['cd-key', 'game-key', 'keys', 'activation-key', 'serial-key'],
    h1Template: 'Buy {mainKeyword} - Instant Delivery | G2G.com',
    sections: [
      {
        subheading: 'Buy {mainKeyword} — Instant Access to Your Game',
        instructions: '~250 words. What the key gives instant access to. How to activate it. Why buying keys on G2G is safe (verified sellers, escrow).',
      },
      {
        subheading: 'Why Buy {mainKeyword} on G2G',
        instructions: '3 paragraphs: GamerProtect, ISO security, 200+ payment methods, 24/7 support.',
      },
      {
        subheading: 'How to Buy {mainKeyword} on G2G',
        instructions: 'Ordered steps for purchasing and receiving a game key.',
      },
      {
        subheading: 'About {gameName}',
        instructions: '~250 words. Game overview, why players want it, what they can do once activated.',
      },
      { subheading: 'Trending Products', instructions: '{{trending_games}}' },
      { subheading: 'FAQ', instructions: '3–5 FAQs on activation, platform compatibility, delivery, refunds.' },
    ],
    keywordRules: 'Main keyword: 1%–4%. Secondary keywords: ≤2%, at least once each.',
    writingRules: 'Clear, factual, buyer-reassuring. <br><br>. No forbidden words. No publishers or competitors.',
    faqFocus: 'Activation, platform compatibility, delivery time, refund policy',
    metaTitleTemplate: 'Buy {mainKeyword} - G2G.com Instant Delivery (≤60 chars)',
    metaDescriptionGuide: '≤110 chars. Instant delivery + trust terms.',
  },

  // ── 💳 Gift Card / Payment Card ──────────────────────────────────────────────
  {
    category: 'Gift Cards / Payment Cards',
    icon: '💳',
    urlPatterns: ['gift-card', 'giftcard', 'payment-card', 'prepaid', 'voucher', 'top-up'],
    h1Template: 'Buy {mainKeyword} - Fast Delivery, Only on G2G.com',
    sections: [
      {
        subheading: '{mainKeyword} — What It Is and What You Can Do With It',
        instructions: 'Explain what the gift card is, how to use it, what benefits it provides. Research official gift card website for features. Include PAA data for user intent.',
      },
      {
        subheading: 'Why Buy {mainKeyword} on G2G',
        instructions: 'GamerProtect, ISO security, 200+ payment methods, verified sellers, 24/7 support.',
      },
      {
        subheading: 'How to Buy {mainKeyword} on G2G',
        instructions: 'Ordered purchase steps.',
      },
      {
        subheading: 'How to Redeem {mainKeyword}',
        instructions: 'Step-by-step redemption guide based on the specific card/platform.',
      },
      { subheading: 'Trending Products', instructions: '{{trending_games}}' },
      { subheading: 'FAQ', instructions: '3–5 FAQs on redemption, region restrictions, expiry, refunds.' },
    ],
    keywordRules: 'Main keyword: 1%–4%. Secondary keywords: ≤2%, at least once.',
    writingRules: 'Conversational, natural. Research the card\'s official features before writing. <br><br>. No forbidden words. No competitors.',
    faqFocus: 'Redemption process, region restrictions, expiry, refund policy',
    metaTitleTemplate: 'Buy {mainKeyword} Only on G2G.com (≤60 chars)',
    metaDescriptionGuide: '≤110 chars. Buying benefit + 3 trust terms.',
  },

  // ── 🧑 Software/Apps Account ─────────────────────────────────────────────────
  {
    category: 'Software / Apps',
    icon: '🧑‍💻',
    urlPatterns: ['software', 'apps', 'subscription', 'saas'],
    h1Template: 'Buy {mainKeyword} - Fast Delivery, 24/7 Support | G2G.com',
    sections: [
      {
        subheading: '{mainKeyword} — What You Can Do With It',
        instructions: '~250 words. Research how the software/app is commonly used. Features, benefits, user intent behind buying accounts. Use entity-focused language: productivity, collaboration, verified sellers, multi-user access, digital productivity tools.',
      },
      {
        subheading: 'Why You Should Buy {mainKeyword} on G2G',
        instructions: 'GamerProtect, ISO security, verified sellers, 200+ payment methods, 24/7 support.',
      },
      {
        subheading: 'How to Buy {mainKeyword} on G2G',
        instructions: 'Ordered purchase steps.',
      },
      {
        subheading: 'About {productName}',
        instructions: '~250 words. Describe the software, its main purpose, why users value it, what makes it worth buying.',
      },
      { subheading: 'Trending Products', instructions: '{{trending_games}}' },
      { subheading: 'FAQ', instructions: '3–5 FAQs on account type, access, delivery, refunds.' },
    ],
    keywordRules: 'Main keyword: 1%–4%. Secondary keywords: ≤2%, at least once.',
    writingRules: 'Professional, productivity-focused, E-E-A-T markers through confident factual tone. <br><br>. No filler words. No competitors.',
    faqFocus: 'Account type/access, subscription sharing, multi-user, delivery, refunds',
    metaTitleTemplate: 'Buy {mainKeyword} - G2G.com (≤60 chars)',
    metaDescriptionGuide: '≤110 chars. Productivity benefit + 3 trust terms.',
  },
]

// ─── URL → Category detector ──────────────────────────────────────────────────
export function detectCategory(url: string): CategoryTemplate | null {
  const path = url.toLowerCase()
  for (const template of CATEGORY_TEMPLATES) {
    if (template.urlPatterns.some(pattern => path.includes(pattern))) {
      return template
    }
  }
  return null
}

// ─── Build category-specific on-page prompt instructions ─────────────────────
export function buildCategoryInstructions(url: string, gameName: string, mainKeyword: string): string {
  const template = detectCategory(url)
  if (!template) {
    return `Write a comprehensive, SEO-optimized product page following G2G.com standards. Focus on buyer intent, trust signals (GamerProtect, escrow, 200+ payment methods), and natural keyword integration. Use <br><br> between paragraphs.`
  }

  const fillTemplate = (s: string) =>
    s.replace(/{mainKeyword}/g, mainKeyword)
     .replace(/{gameName}/g, gameName || mainKeyword)
     .replace(/{productName}/g, gameName || mainKeyword)

  const sectionGuide = template.sections
    .map((s, i) => `SECTION ${i + 1} — ${fillTemplate(s.subheading)}\n${s.instructions}`)
    .join('\n\n')

  return `
CATEGORY TYPE: ${template.icon} ${template.category}
MAIN KEYWORD: ${mainKeyword}
GAME/PRODUCT NAME: ${gameName}

=== PAGE STRUCTURE TO FOLLOW ===
${sectionGuide}

=== KEYWORD RULES ===
${template.keywordRules}

=== WRITING RULES ===
${template.writingRules}

=== FAQ FOCUS ===
${template.faqFocus}

=== META DATA ===
Title format: ${fillTemplate(template.metaTitleTemplate)}
Description: ${template.metaDescriptionGuide}

IMPORTANT: Output must use HTML format with <br><br> between paragraphs. H1 format: ${fillTemplate(template.h1Template)}
Include {{trending_games}} placeholder in the Trending Products section exactly as shown.
`.trim()
}
