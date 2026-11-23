import type { AgentChoice } from "@deskfleet/client/agent-configuration"

export interface PeriodicElement {
  number: number
  symbol: string
  name: string
  /** Main periodic table period (1..6). Undefined for f-block / period 7 elements outside the main grid. */
  row?: number
  /** Main periodic table group (1..18). */
  col?: number
  /** Space-separated RGB channels used with `rgb(var(--el-rgb) / <alpha>)` for light and dark themes. */
  rgb: string
}

export interface GeminiPeriodicEntry {
  element: PeriodicElement
  models: AgentChoice[]
}

/** Signature colors for known Gemini 4 elements, matching the periodic table palette. */
const SIGNATURE_RGB: Record<number, string> = {
  1: "96 124 235", // H — Hydrogen (sapphire indigo)
  6: "132 104 228", // C — Carbon (amethyst violet)
  10: "240 101 67", // Ne — Neon (glowing coral-orange)
  18: "52 168 106", // Ar — Argon (emerald green)
}

const GROUP_RGB: Record<number, string> = {
  1: "234 148 56", // Alkali metals
  2: "214 166 56", // Alkaline earth metals
  13: "58 168 176", // Boron group
  14: "126 106 226", // Carbon group
  15: "92 128 232", // Pnictogens
  16: "78 156 228", // Chalcogens
  17: "224 98 138", // Halogens
  18: "56 172 128", // Noble gases
}

function elementRgb(number: number, col?: number): string {
  if (SIGNATURE_RGB[number]) return SIGNATURE_RGB[number]
  if (col && GROUP_RGB[col]) return GROUP_RGB[col]
  if (col && col >= 3 && col <= 12) return "68 156 218" // Transition metals
  return "168 108 220" // Lanthanides / actinides
}

type MainRowTuple = [number: number, symbol: string, name: string, row: number, col: number]

const MAIN_GRID_TUPLES: readonly MainRowTuple[] = [
  // Period 1
  [1, "H", "Hydrogen", 1, 1],
  [2, "He", "Helium", 1, 18],
  // Period 2
  [3, "Li", "Lithium", 2, 1],
  [4, "Be", "Beryllium", 2, 2],
  [5, "B", "Boron", 2, 13],
  [6, "C", "Carbon", 2, 14],
  [7, "N", "Nitrogen", 2, 15],
  [8, "O", "Oxygen", 2, 16],
  [9, "F", "Fluorine", 2, 17],
  [10, "Ne", "Neon", 2, 18],
  // Period 3
  [11, "Na", "Sodium", 3, 1],
  [12, "Mg", "Magnesium", 3, 2],
  [13, "Al", "Aluminum", 3, 13],
  [14, "Si", "Silicon", 3, 14],
  [15, "P", "Phosphorus", 3, 15],
  [16, "S", "Sulfur", 3, 16],
  [17, "Cl", "Chlorine", 3, 17],
  [18, "Ar", "Argon", 3, 18],
  // Period 4
  [19, "K", "Potassium", 4, 1],
  [20, "Ca", "Calcium", 4, 2],
  [21, "Sc", "Scandium", 4, 3],
  [22, "Ti", "Titanium", 4, 4],
  [23, "V", "Vanadium", 4, 5],
  [24, "Cr", "Chromium", 4, 6],
  [25, "Mn", "Manganese", 4, 7],
  [26, "Fe", "Iron", 4, 8],
  [27, "Co", "Cobalt", 4, 9],
  [28, "Ni", "Nickel", 4, 10],
  [29, "Cu", "Copper", 4, 11],
  [30, "Zn", "Zinc", 4, 12],
  [31, "Ga", "Gallium", 4, 13],
  [32, "Ge", "Germanium", 4, 14],
  [33, "As", "Arsenic", 4, 15],
  [34, "Se", "Selenium", 4, 16],
  [35, "Br", "Bromine", 4, 17],
  [36, "Kr", "Krypton", 4, 18],
  // Period 5
  [37, "Rb", "Rubidium", 5, 1],
  [38, "Sr", "Strontium", 5, 2],
  [39, "Y", "Yttrium", 5, 3],
  [40, "Zr", "Zirconium", 5, 4],
  [41, "Nb", "Niobium", 5, 5],
  [42, "Mo", "Molybdenum", 5, 6],
  [43, "Tc", "Technetium", 5, 7],
  [44, "Ru", "Ruthenium", 5, 8],
  [45, "Rh", "Rhodium", 5, 9],
  [46, "Pd", "Palladium", 5, 10],
  [47, "Ag", "Silver", 5, 11],
  [48, "Cd", "Cadmium", 5, 12],
  [49, "In", "Indium", 5, 13],
  [50, "Sn", "Tin", 5, 14],
  [51, "Sb", "Antimony", 5, 15],
  [52, "Te", "Tellurium", 5, 16],
  [53, "I", "Iodine", 5, 17],
  [54, "Xe", "Xenon", 5, 18],
  // Period 6 (faded bottom row unless a model matches)
  [55, "Cs", "Cesium", 6, 1],
  [56, "Ba", "Barium", 6, 2],
  [72, "Hf", "Hafnium", 6, 4],
  [73, "Ta", "Tantalum", 6, 5],
  [74, "W", "Tungsten", 6, 6],
  [75, "Re", "Rhenium", 6, 7],
  [76, "Os", "Osmium", 6, 8],
  [77, "Ir", "Iridium", 6, 9],
  [78, "Pt", "Platinum", 6, 10],
  [79, "Au", "Gold", 6, 11],
  [80, "Hg", "Mercury", 6, 12],
  [81, "Tl", "Thallium", 6, 13],
  [82, "Pb", "Lead", 6, 14],
  [83, "Bi", "Bismuth", 6, 15],
  [84, "Po", "Polonium", 6, 16],
  [85, "At", "Astatine", 6, 17],
  [86, "Rn", "Radon", 6, 18],
]

/** Remaining IUPAC elements (lanthanides, period 7, actinides) for future-proof name matching. */
const EXTRA_ELEMENT_TUPLES: readonly [number, string, string][] = [
  [57, "La", "Lanthanum"], [58, "Ce", "Cerium"], [59, "Pr", "Praseodymium"], [60, "Nd", "Neodymium"],
  [61, "Pm", "Promethium"], [62, "Sm", "Samarium"], [63, "Eu", "Europium"], [64, "Gd", "Gadolinium"],
  [65, "Tb", "Terbium"], [66, "Dy", "Dysprosium"], [67, "Ho", "Holmium"], [68, "Er", "Erbium"],
  [69, "Tm", "Thulium"], [70, "Yb", "Ytterbium"], [71, "Lu", "Lutetium"],
  [87, "Fr", "Francium"], [88, "Ra", "Radium"], [89, "Ac", "Actinium"], [90, "Th", "Thorium"],
  [91, "Pa", "Protactinium"], [92, "U", "Uranium"], [93, "Np", "Neptunium"], [94, "Pu", "Plutonium"],
  [95, "Am", "Americium"], [96, "Cm", "Curium"], [97, "Bk", "Berkelium"], [98, "Cf", "Californium"],
  [99, "Es", "Einsteinium"], [100, "Fm", "Fermium"], [101, "Md", "Mendelevium"], [102, "No", "Nobelium"],
  [103, "Lr", "Lawrencium"], [104, "Rf", "Rutherfordium"], [105, "Db", "Dubnium"], [106, "Sg", "Seaborgium"],
  [107, "Bh", "Bohrium"], [108, "Hs", "Hassium"], [109, "Mt", "Meitnerium"], [110, "Ds", "Darmstadtium"],
  [111, "Rg", "Roentgenium"], [112, "Cn", "Copernicium"], [113, "Nh", "Nihonium"], [114, "Fl", "Flerovium"],
  [115, "Mc", "Moscovium"], [116, "Lv", "Livermorium"], [117, "Ts", "Tennessine"], [118, "Og", "Oganesson"],
]

/** Elements rendered in the 18×6 main periodic table grid. */
export const PERIODIC_TABLE_ELEMENTS: readonly PeriodicElement[] = MAIN_GRID_TUPLES.map(
  ([number, symbol, name, row, col]) => ({ number, symbol, name, row, col, rgb: elementRgb(number, col) }),
)

const EXTRA_ELEMENTS: readonly PeriodicElement[] = EXTRA_ELEMENT_TUPLES.map(
  ([number, symbol, name]) => ({ number, symbol, name, rgb: elementRgb(number) }),
)

const ELEMENT_BY_NAME = new Map<string, PeriodicElement>()
for (const element of [...PERIODIC_TABLE_ELEMENTS, ...EXTRA_ELEMENTS]) {
  ELEMENT_BY_NAME.set(element.name.toLowerCase(), element)
}
// Common alternate English spellings.
ELEMENT_BY_NAME.set("aluminium", ELEMENT_BY_NAME.get("aluminum")!)
ELEMENT_BY_NAME.set("caesium", ELEMENT_BY_NAME.get("cesium")!)
ELEMENT_BY_NAME.set("sulphur", ELEMENT_BY_NAME.get("sulfur")!)

const GEMINI_4_PATTERN = /\bgemini(?:[\s._-]*4(?:\.\d+)?)\b|gemini4(?:\b|[_-])/iu

function findElementInText(text: string): PeriodicElement | null {
  for (const token of text.toLowerCase().split(/[^a-z]+/u)) {
    if (!token) continue
    const found = ELEMENT_BY_NAME.get(token)
    if (found) return found
  }
  return null
}

/** Matches a Gemini 4 model option to its periodic table element by full element name. */
export function matchGemini4Element(option: Pick<AgentChoice, "id" | "name">): PeriodicElement | null {
  if (!GEMINI_4_PATTERN.test(option.name) && !GEMINI_4_PATTERN.test(option.id)) return null
  return findElementInText(option.name) ?? findElementInText(option.id)
}

/** Groups all Gemini 4 model options by atomic number, preserving option order within each element. */
export function buildGeminiPeriodicEntries(options: readonly AgentChoice[]): Map<number, GeminiPeriodicEntry> {
  const entries = new Map<number, GeminiPeriodicEntry>()
  for (const option of options) {
    const element = matchGemini4Element(option)
    if (!element) continue
    const existing = entries.get(element.number)
    if (existing) existing.models.push(option)
    else entries.set(element.number, { element, models: [option] })
  }
  return entries
}

/** Finds the periodic element for a currently selected model ID, if it is a Gemini 4 model. */
export function findGemini4ElementById(options: readonly AgentChoice[], modelId?: string): PeriodicElement | null {
  if (!modelId) return null
  const option = options.find(item => item.id === modelId)
  if (option) return matchGemini4Element(option)
  return matchGemini4Element({ id: modelId, name: modelId })
}

/** Derives a short variant label when one element has multiple model entries (e.g. "(High)" -> "High"). */
export function extractGeminiVariantLabel(option: Pick<AgentChoice, "id" | "name">, element: PeriodicElement): string {
  const paren = /\(([^)]+)\)\s*$/u.exec(option.name)
  if (paren?.[1]?.trim()) return paren[1].trim()
  const afterElement = new RegExp(`\\b${element.name}\\b[\\s\\-–—:/]+(.+)$`, "iu").exec(option.name)
  if (afterElement?.[1]?.trim()) return afterElement[1].trim()
  return option.name
}
