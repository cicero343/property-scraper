# property-scraper

Searches Rightmove and Zoopla simultaneously, merges the results into a single browsable HTML report, and tracks what you've seen across runs.

## Why use this?

**One report across both sites** — Rightmove and Zoopla results combined and deduplicated. The same property listed on both is flagged rather than appearing twice.

**No chain first** — chain-free listings are surfaced at the top regardless of price.

**Seen-before tracking** — run the same search the next day and previously seen listings are marked so you focus on what's new.

**Freehold filtering that works** — tenure is passed as a native parameter to each site, not approximated.

**Price per sq ft analysis** — the refiner script colour-codes listings by value for space relative to your own results, so you can compare like for like.

## Files

| File | Purpose |
| --- | --- |
| `property-scraper.ts` | Main script |
| `property-scraper-launch.ps1` | Windows launcher — installs dependencies and runs the script |
| `property-scraper-launch.sh` | Mac / Linux launcher |
| `refine-results.py` | Optional refiner — price per sq ft, keyword scoring, agent grouping |

## Requirements

- [Node.js](https://nodejs.org/) v18 or higher — handled automatically by the launch script
- Python 3 — for the refiner only, no additional packages needed
- A Zoopla cookie file (`zoopla-cookies.json`) — strongly recommended.

## Getting started

Clone the repository and navigate to the property-scraper folder:

```bash
git clone https://github.com/cicero343/property-scraper.git
cd scrapers/property-scraper
```

### Windows

Allow PowerShell scripts if needed (once only):

```powershell
Unblock-File .\property-scraper-launch.ps1
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Then launch:

```powershell
.\property-scraper-launch.ps1
```

### Mac / Linux

```bash
chmod +x property-scraper-launch.sh
./property-scraper-launch.sh
```

The launch script handles Node.js verification, npm dependencies, and Playwright browser installation. Subsequent runs skip straight to launching.

## Usage

The script prompts you for everything it needs. Key parameters include site selection (Rightmove, Zoopla, or both), location, radius, price range, bedrooms, tenure, chain-free, must-haves, and listed-within date. Rightmove and Zoopla each have a small number of site-specific options which are only asked when that site is selected.

Press Enter at any prompt to use the default or skip optional filters.

## Output files

| File | Description |
| --- | --- |
| `results-property-{location}-{date}.html` | Combined report — open in any browser |
| `results-property-rightmove-{location}-{date}.html` | Rightmove-only report |
| `results-property-zoopla-{location}-{date}.html` | Zoopla-only report |
| `results-property-refined-{date}.html` | Refined report from `refine-property-results.py` |
| `seen-properties.json` | Tracks seen listings across runs — delete to reset |

**Report badges**

| Badge | Meaning |
| --- | --- |
| 🔵 **Rightmove** | Listing sourced from Rightmove |
| 🟣 **Zoopla** | Listing sourced from Zoopla |
| 🟢 **NO CHAIN** | No onward chain — seller has no property to buy |
| ⚫ **SSTC** | Sold subject to contract / under offer |
| 🟠 **SEEN BEFORE** | Appeared in a previous run |
| 🟣 **DUPLICATE** | Same property found on both sites this run |

## Refiner script

```bash
python refine-property-results.py
```

Run from the same folder as your results files. Auto-detects `results-property-*.html` files or accepts filenames as arguments. Produces `results-property-refined-{date}.html` with:

- **Price per sq ft** — colour-coded green / amber / red based on where each listing falls in the distribution of your results (bottom third = best value, top third = most expensive per sq ft). Average and data coverage shown in the report header.
- **Keyword scoring** — optional boost and penalise keywords matched against address, property type, agent, and tags. Boosted listings get a green `+N` badge, penalised listings get a red `−N` badge and reduced opacity. Both prompts are skippable.
- **High volume agent grouping** — agents with an unusually high listing count are grouped at the bottom. Threshold is calculated dynamically from the distribution so it scales with result size.
- **Sort order** — price ascending, with floor area descending as a tiebreaker at the same price.

## Seen-before tracking

Property IDs are saved to `seen-properties.json` after each run, prefixed by site (`rightmove:12345`, `zoopla:67890`). Delete the file to treat all listings as new on the next run.

## Disclaimer

For personal, educational use only. Demonstrates browser automation techniques using Playwright. Designed and tested for UK property sites. Please respect the terms of service of any site you interact with.

## License

MIT License — see [LICENSE](https://github.com/cicero343/property-scraper/blob/main/LICENSE) for details.
