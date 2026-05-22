// Smoke test for buildDeck with synthetic data
import { buildDeck } from './generate-seo-evolution-deck'

const fake = {
  total_keywords:         552,
  total_winners:          461,
  total_products:         159,
  products_with_winners:  156,
  winners_top3:           312,
  winners_top4to10:       89,
  winners_beyond10:       42,
  winners_untracked:      18,
  hugin_discovered_count: 247,
  hugin_avg_growth_pct:   68.4,
  hugin_high_growth_count: 84,
  freyja_mentions_total:  1240,
  brands:                 ['g2g'],
}

const pres = buildDeck(fake)
const outPath = '/sessions/nifty-gracious-mayer/mnt/outputs/seo-evolution-deck-test.pptx'
pres.writeFile({ fileName: outPath }).then(() => console.log('Saved:', outPath))
