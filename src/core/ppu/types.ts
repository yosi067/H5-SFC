/**
 * Project 16-bit: SFC Emulator
 * PPU (Picture Processing Unit) Types and Constants
 */

// ============================================================================
// Display Constants
// ============================================================================

export const PPU_CONSTANTS = {
  // Screen dimensions
  SCREEN_WIDTH: 256,
  SCREEN_HEIGHT: 224,  // Can be 239 in overscan mode
  
  // VRAM
  VRAM_SIZE: 0x10000,  // 64KB
  
  // OAM (Object Attribute Memory)
  OAM_SIZE: 0x200,     // 512 bytes (main table)
  OAM_HIGH_TABLE_SIZE: 0x20,  // 32 bytes (high table)
  MAX_SPRITES: 128,
  
  // CGRAM (Color Generator RAM)
  CGRAM_SIZE: 0x200,   // 512 bytes = 256 colors
  
  // Timing
  DOTS_PER_SCANLINE: 341,
  SCANLINES_NTSC: 262,
  SCANLINES_PAL: 312,
  SCANLINES_PER_FRAME: 262,  // Default to NTSC
  VBLANK_START: 225,         // Default to NTSC
  VBLANK_START_NTSC: 225,
  VBLANK_START_PAL: 240,
  
  // Tile sizes
  TILE_SIZE_8: 8,
  TILE_SIZE_16: 16,
} as const;

// ============================================================================
// Background Modes
// ============================================================================

export enum BGMode {
  MODE_0 = 0,  // 4 layers, all 2bpp (4 colors)
  MODE_1 = 1,  // 2 layers 4bpp + 1 layer 2bpp
  MODE_2 = 2,  // 2 layers 4bpp, offset-per-tile
  MODE_3 = 3,  // 1 layer 8bpp + 1 layer 4bpp
  MODE_4 = 4,  // 1 layer 8bpp + 1 layer 2bpp, offset-per-tile
  MODE_5 = 5,  // 1 layer 4bpp + 1 layer 2bpp, hi-res
  MODE_6 = 6,  // 1 layer 4bpp, hi-res + offset-per-tile
  MODE_7 = 7,  // 1 layer 8bpp, rotation/scaling
}

// ============================================================================
// Sprite Sizes
// ============================================================================

export enum SpriteSize {
  SIZE_8x8_16x16 = 0,
  SIZE_8x8_32x32 = 1,
  SIZE_8x8_64x64 = 2,
  SIZE_16x16_32x32 = 3,
  SIZE_16x16_64x64 = 4,
  SIZE_32x32_64x64 = 5,
  SIZE_16x32_32x64 = 6,
  SIZE_16x32_32x32 = 7,
}

export const SPRITE_SIZES: readonly [readonly [number, number], readonly [number, number]][] = [
  [[8, 8], [16, 16]],   // 0
  [[8, 8], [32, 32]],   // 1
  [[8, 8], [64, 64]],   // 2
  [[16, 16], [32, 32]], // 3
  [[16, 16], [64, 64]], // 4
  [[32, 32], [64, 64]], // 5
  [[16, 32], [32, 64]], // 6
  [[16, 32], [32, 32]], // 7
];

// ============================================================================
// PPU Registers
// ============================================================================

export const PPU_REG = {
  // Screen settings
  INIDISP: 0x2100,  // Display control 1
  OBSEL: 0x2101,    // Object size and base
  OAMADDL: 0x2102,  // OAM address low
  OAMADDH: 0x2103,  // OAM address high
  OAMDATA: 0x2104,  // OAM data write
  
  // BG settings
  BGMODE: 0x2105,   // BG mode and tile size
  MOSAIC: 0x2106,   // Mosaic size and enable
  BG1SC: 0x2107,    // BG1 tilemap address
  BG2SC: 0x2108,    // BG2 tilemap address
  BG3SC: 0x2109,    // BG3 tilemap address
  BG4SC: 0x210A,    // BG4 tilemap address
  BG12NBA: 0x210B,  // BG1/2 tile base address
  BG34NBA: 0x210C,  // BG3/4 tile base address
  
  // BG scroll
  BG1HOFS: 0x210D,  // BG1 horizontal scroll
  BG1VOFS: 0x210E,  // BG1 vertical scroll
  BG2HOFS: 0x210F,  // BG2 horizontal scroll
  BG2VOFS: 0x2110,  // BG2 vertical scroll
  BG3HOFS: 0x2111,  // BG3 horizontal scroll
  BG3VOFS: 0x2112,  // BG3 vertical scroll
  BG4HOFS: 0x2113,  // BG4 horizontal scroll
  BG4VOFS: 0x2114,  // BG4 vertical scroll
  
  // VRAM
  VMAIN: 0x2115,    // VRAM address increment
  VMADDL: 0x2116,   // VRAM address low
  VMADDH: 0x2117,   // VRAM address high
  VMDATAL: 0x2118,  // VRAM data write low
  VMDATAH: 0x2119,  // VRAM data write high
  
  // Mode 7
  M7SEL: 0x211A,    // Mode 7 settings
  M7A: 0x211B,      // Mode 7 matrix A (scale X)
  M7B: 0x211C,      // Mode 7 matrix B (shear X)
  M7C: 0x211D,      // Mode 7 matrix C (shear Y)
  M7D: 0x211E,      // Mode 7 matrix D (scale Y)
  M7X: 0x211F,      // Mode 7 center X
  M7Y: 0x2120,      // Mode 7 center Y
  
  // CGRAM
  CGADD: 0x2121,    // CGRAM address
  CGDATA: 0x2122,   // CGRAM data write
  
  // Window
  W12SEL: 0x2123,   // Window 1/2 mask settings BG1/2
  W34SEL: 0x2124,   // Window 1/2 mask settings BG3/4
  WOBJSEL: 0x2125,  // Window 1/2 mask settings OBJ/Color
  WH0: 0x2126,      // Window 1 left position
  WH1: 0x2127,      // Window 1 right position
  WH2: 0x2128,      // Window 2 left position
  WH3: 0x2129,      // Window 2 right position
  WBGLOG: 0x212A,   // Window BG logic
  WOBJLOG: 0x212B,  // Window OBJ/Color logic
  
  // Screen
  TM: 0x212C,       // Main screen designation
  TS: 0x212D,       // Sub screen designation
  TMW: 0x212E,      // Window mask main screen
  TSW: 0x212F,      // Window mask sub screen
  
  // Color math
  CGWSEL: 0x2130,   // Color addition select
  CGADSUB: 0x2131,  // Color add/subtract
  COLDATA: 0x2132,  // Fixed color data
  
  // Display
  SETINI: 0x2133,   // Display mode settings
  
  // Read registers
  MPYL: 0x2134,     // Multiplication result low
  MPYM: 0x2135,     // Multiplication result mid
  MPYH: 0x2136,     // Multiplication result high
  SLHV: 0x2137,     // Software latch H/V counter
  OAMDATAREAD: 0x2138, // OAM data read
  VMDATALREAD: 0x2139, // VRAM data read low
  VMDATAHREAD: 0x213A, // VRAM data read high
  CGDATAREAD: 0x213B,  // CGRAM data read
  OPHCT: 0x213C,    // H counter read
  OPVCT: 0x213D,    // V counter read
  STAT77: 0x213E,   // PPU1 status
  STAT78: 0x213F,   // PPU2 status
} as const;

// ============================================================================
// Layer Configuration
// ============================================================================

export interface LayerConfig {
  enabled: boolean;
  tileSize: 8 | 16;
  tilemapAddress: number;
  tilemapWidth: number;   // 32 or 64
  tilemapHeight: number;  // 32 or 64
  tileDataAddress: number;
  bpp: 2 | 4 | 8;
  hScroll: number;
  vScroll: number;
  priority: number;
}

// ============================================================================
// Sprite Entry
// ============================================================================

export interface SpriteEntry {
  x: number;          // 0-511 (9-bit)
  y: number;          // 0-255
  tile: number;       // Tile number
  nameTable: number;  // Name table select
  palette: number;    // Palette (0-7)
  priority: number;   // Priority (0-3)
  hFlip: boolean;     // Horizontal flip
  vFlip: boolean;     // Vertical flip
  size: boolean;      // 0 = small, 1 = large
}

// ============================================================================
// Mode 7 Parameters
// ============================================================================

export interface Mode7Params {
  a: number;  // Matrix A (1.7.8 fixed point)
  b: number;  // Matrix B
  c: number;  // Matrix C
  d: number;  // Matrix D
  centerX: number;  // Center X (13-bit signed)
  centerY: number;  // Center Y (13-bit signed)
  hScroll: number;  // H scroll (13-bit signed)
  vScroll: number;  // V scroll (13-bit signed)
  
  // M7SEL flags (aliases for compatibility)
  hFlip: boolean;
  vFlip: boolean;
  flipX: boolean;
  flipY: boolean;
  repeat: number;   // 0-3: repeat mode
}

// ============================================================================
// PPU State (for save states)
// ============================================================================

export interface PPUState {
  vram: Uint8Array;
  oam: Uint8Array;
  cgram: Uint8Array;
  registers: Uint8Array;
  
  scanline: number;
  dot: number;
  frameCount: number;
  
  mode7: Mode7Params;
  
  // Additional register states for tests
  inidisp: number;
  obsel: number;
  bgmode: number;
  bg1sc: number;
  bg2sc: number;
  bg3sc: number;
  bg4sc: number;
  tm: number;
  ts: number;
  oamAddr: number;
  window1Left: number;
  window1Right: number;
  window2Left: number;
  window2Right: number;
  w12sel: number;
  w34sel: number;
  cgwsel: number;
  cgadsub: number;
  fixedColor: number;
  setini: number;
}
