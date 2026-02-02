/**
 * Project 16-bit: SFC Emulator
 * PPU (Picture Processing Unit) Core Implementation
 * 
 * Implements the SNES PPU including:
 * - Background layers (Modes 0-7)
 * - Sprites (OAM)
 * - Color math
 * - Window masking
 * - Mode 7 affine transformations
 */

import {
  PPU_CONSTANTS,
  PPU_REG,
  BGMode,
  SPRITE_SIZES,
  LayerConfig,
  SpriteEntry,
  Mode7Params,
  PPUState,
} from './types';

export class PPU {
  // Video memory
  private vram: Uint8Array = new Uint8Array(PPU_CONSTANTS.VRAM_SIZE);
  private oam: Uint8Array = new Uint8Array(PPU_CONSTANTS.OAM_SIZE + PPU_CONSTANTS.OAM_HIGH_TABLE_SIZE);
  private cgram: Uint8Array = new Uint8Array(PPU_CONSTANTS.CGRAM_SIZE);
  
  // Output framebuffer (15-bit RGB)
  private framebuffer: Uint16Array = new Uint16Array(
    PPU_CONSTANTS.SCREEN_WIDTH * PPU_CONSTANTS.SCREEN_HEIGHT
  );
  
  // Timing
  private scanline: number = 0;
  private dot: number = 0;
  private frameCount: number = 0;
  private isNTSC: boolean = true;
  
  // Display control
  private displayEnabled: boolean = true;
  private brightness: number = 0x0F;
  private overscan: boolean = false;
  
  // Background mode
  private bgMode: BGMode = BGMode.MODE_0;
  private bg3Priority: boolean = false;
  
  // Layer configurations
  private layers: LayerConfig[] = Array(4).fill(null).map(() => ({
    enabled: false,
    tileSize: 8 as const,
    tilemapAddress: 0,
    tilemapWidth: 32,
    tilemapHeight: 32,
    tileDataAddress: 0,
    bpp: 2 as const,
    hScroll: 0,
    vScroll: 0,
    priority: 0,
  }));
  
  // Sprite settings
  private spriteBaseAddress: number = 0;
  private spriteNameSelect: number = 0;
  private spriteSizeIndex: number = 0;
  
  // Mode 7 parameters
  private mode7: Mode7Params = {
    a: 0x100,
    b: 0,
    c: 0,
    d: 0x100,
    centerX: 0,
    centerY: 0,
    hScroll: 0,
    vScroll: 0,
    hFlip: false,
    vFlip: false,
    flipX: false,
    flipY: false,
    repeat: 0,
  };
  
  // VRAM access
  private vramAddress: number = 0;
  private vramIncrement: number = 1;
  private vramIncrementHigh: boolean = true;
  private vramReadBuffer: number = 0;
  
  // OAM access
  private oamAddress: number = 0;
  private oamWriteBuffer: number = 0;
  private oamPriority: boolean = false;
  
  // CGRAM access
  private cgramAddress: number = 0;
  private cgramWriteBuffer: number = 0;
  private cgramLatch: boolean = false;
  
  // Scroll latches
  private scrollLatch: number = 0;
  private mode7Latch: number = 0;
  
  // Window settings
  private window1Left: number = 0;
  private window1Right: number = 0;
  private window2Left: number = 0;
  private window2Right: number = 0;
  private w12sel: number = 0;
  private w34sel: number = 0;
  
  // Screen designation
  private mainScreen: number = 0;
  private subScreen: number = 0;
  
  // Color math
  private colorMathEnabled: number = 0;
  private colorMathMode: number = 0;
  private fixedColor: number = 0;
  private cgwsel: number = 0;
  private cgadsub: number = 0;
  
  // Mosaic
  private mosaicSize: number = 0;
  private mosaicEnabled: number = 0;
  
  // SETINI register
  private setini: number = 0;
  
  // OBSEL register cache
  private obsel: number = 0;
  
  // Register cache for save state
  private inidisp: number = 0x80;
  private bg1sc: number = 0;
  private bg2sc: number = 0;
  private bg3sc: number = 0;
  private bg4sc: number = 0;
  
  // H/V counters
  private hCounter: number = 0;
  private vCounter: number = 0;
  private counterLatch: boolean = false;
  
  // Multiplication result (Mode 7)
  private multiplyResult: number = 0;
  
  // Line buffers for rendering
  private mainBuffer: Uint16Array = new Uint16Array(PPU_CONSTANTS.SCREEN_WIDTH);
  private subBuffer: Uint16Array = new Uint16Array(PPU_CONSTANTS.SCREEN_WIDTH);
  private priorityBuffer: Uint8Array = new Uint8Array(PPU_CONSTANTS.SCREEN_WIDTH);
  
  // Callbacks
  private onVBlank: (() => void) | null = null;
  private onHBlank: (() => void) | null = null;
  
  constructor() {
    this.reset();
  }
  
  reset(): void {
    this.vram.fill(0);
    this.oam.fill(0);
    this.cgram.fill(0);
    this.framebuffer.fill(0);
    
    this.scanline = 0;
    this.dot = 0;
    this.frameCount = 0;
    
    this.displayEnabled = true;
    this.brightness = 0x0F;
    
    this.bgMode = BGMode.MODE_0;
    this.vramAddress = 0;
    this.vramIncrement = 1;
    this.oamAddress = 0;
    this.cgramAddress = 0;
    
    this.resetMode7();
  }
  
  private resetMode7(): void {
    this.mode7 = {
      a: 0x100,
      b: 0,
      c: 0,
      d: 0x100,
      centerX: 0,
      centerY: 0,
      hScroll: 0,
      vScroll: 0,
      hFlip: false,
      vFlip: false,
      flipX: false,
      flipY: false,
      repeat: 0,
    };
  }
  
  // ============================================================================
  // Register Access
  // ============================================================================
  
  readRegister(address: number): number {
    switch (address) {
      case PPU_REG.MPYL:
        return this.multiplyResult & 0xFF;
      case PPU_REG.MPYM:
        return (this.multiplyResult >> 8) & 0xFF;
      case PPU_REG.MPYH:
        return (this.multiplyResult >> 16) & 0xFF;
        
      case PPU_REG.SLHV:
        // Latch H/V counters
        this.hCounter = this.dot;
        this.vCounter = this.scanline;
        this.counterLatch = false;
        return 0;
        
      case PPU_REG.OAMDATAREAD:
        return this.readOAM();
        
      case PPU_REG.VMDATALREAD:
        return this.readVRAMLow();
        
      case PPU_REG.VMDATAHREAD:
        return this.readVRAMHigh();
        
      case PPU_REG.CGDATAREAD:
        return this.readCGRAM();
        
      case PPU_REG.OPHCT:
        if (!this.counterLatch) {
          this.counterLatch = true;
          return this.hCounter & 0xFF;
        }
        return (this.hCounter >> 8) & 0x01;
        
      case PPU_REG.OPVCT:
        if (!this.counterLatch) {
          this.counterLatch = true;
          return this.vCounter & 0xFF;
        }
        return (this.vCounter >> 8) & 0x01;
        
      case PPU_REG.STAT77:
        // PPU1 status (time over/range over flags)
        return 0x01; // PPU1 version
        
      case PPU_REG.STAT78:
        // PPU2 status (interlace, external latch, PAL)
        this.counterLatch = false;
        return this.isNTSC ? 0x01 : 0x11;
        
      default:
        return 0;
    }
  }
  
  writeRegister(address: number, value: number): void {
    switch (address) {
      case PPU_REG.INIDISP:
        this.inidisp = value;
        this.displayEnabled = (value & 0x80) === 0;
        this.brightness = value & 0x0F;
        break;
        
      case PPU_REG.OBSEL:
        this.obsel = value;
        this.spriteBaseAddress = (value & 0x07) << 14;
        this.spriteNameSelect = ((value >> 3) & 0x03) << 13;
        this.spriteSizeIndex = (value >> 5) & 0x07;
        break;
        
      case PPU_REG.OAMADDL:
        this.oamAddress = (this.oamAddress & 0x100) | value;
        break;
        
      case PPU_REG.OAMADDH:
        this.oamAddress = (this.oamAddress & 0xFF) | ((value & 0x01) << 8);
        this.oamPriority = (value & 0x80) !== 0;
        break;
        
      case PPU_REG.OAMDATA:
        this.writeOAM(value);
        break;
        
      case PPU_REG.BGMODE:
        this.bgMode = value & 0x07;
        this.bg3Priority = (value & 0x08) !== 0;
        this.layers[0].tileSize = (value & 0x10) ? 16 : 8;
        this.layers[1].tileSize = (value & 0x20) ? 16 : 8;
        this.layers[2].tileSize = (value & 0x40) ? 16 : 8;
        this.layers[3].tileSize = (value & 0x80) ? 16 : 8;
        this.updateLayerBPP();
        break;
        
      case PPU_REG.MOSAIC:
        this.mosaicSize = (value >> 4) + 1;
        this.mosaicEnabled = value & 0x0F;
        break;
        
      case PPU_REG.BG1SC:
      case PPU_REG.BG2SC:
      case PPU_REG.BG3SC:
      case PPU_REG.BG4SC:
        const bgIndex = address - PPU_REG.BG1SC;
        this.layers[bgIndex].tilemapAddress = (value & 0xFC) << 9;
        this.layers[bgIndex].tilemapWidth = (value & 0x01) ? 64 : 32;
        this.layers[bgIndex].tilemapHeight = (value & 0x02) ? 64 : 32;
        // Cache for getState()
        if (bgIndex === 0) this.bg1sc = value;
        else if (bgIndex === 1) this.bg2sc = value;
        else if (bgIndex === 2) this.bg3sc = value;
        else if (bgIndex === 3) this.bg4sc = value;
        break;
        
      case PPU_REG.BG12NBA:
        this.layers[0].tileDataAddress = (value & 0x0F) << 13;
        this.layers[1].tileDataAddress = (value >> 4) << 13;
        break;
        
      case PPU_REG.BG34NBA:
        this.layers[2].tileDataAddress = (value & 0x0F) << 13;
        this.layers[3].tileDataAddress = (value >> 4) << 13;
        break;
        
      case PPU_REG.BG1HOFS:
        this.layers[0].hScroll = ((value << 8) | (this.scrollLatch & 0xF8) | 
                                  ((this.layers[0].hScroll >> 8) & 0x07)) & 0x3FF;
        this.scrollLatch = value;
        // Mode 7 H scroll
        this.mode7.hScroll = this.signExtend13(
          ((value << 8) | this.mode7Latch) & 0x1FFF
        );
        this.mode7Latch = value;
        break;
        
      case PPU_REG.BG1VOFS:
        this.layers[0].vScroll = ((value << 8) | this.scrollLatch) & 0x3FF;
        this.scrollLatch = value;
        // Mode 7 V scroll
        this.mode7.vScroll = this.signExtend13(
          ((value << 8) | this.mode7Latch) & 0x1FFF
        );
        this.mode7Latch = value;
        break;
        
      case PPU_REG.BG2HOFS:
        this.layers[1].hScroll = ((value << 8) | (this.scrollLatch & 0xF8) |
                                  ((this.layers[1].hScroll >> 8) & 0x07)) & 0x3FF;
        this.scrollLatch = value;
        break;
        
      case PPU_REG.BG2VOFS:
        this.layers[1].vScroll = ((value << 8) | this.scrollLatch) & 0x3FF;
        this.scrollLatch = value;
        break;
        
      case PPU_REG.BG3HOFS:
        this.layers[2].hScroll = ((value << 8) | (this.scrollLatch & 0xF8) |
                                  ((this.layers[2].hScroll >> 8) & 0x07)) & 0x3FF;
        this.scrollLatch = value;
        break;
        
      case PPU_REG.BG3VOFS:
        this.layers[2].vScroll = ((value << 8) | this.scrollLatch) & 0x3FF;
        this.scrollLatch = value;
        break;
        
      case PPU_REG.BG4HOFS:
        this.layers[3].hScroll = ((value << 8) | (this.scrollLatch & 0xF8) |
                                  ((this.layers[3].hScroll >> 8) & 0x07)) & 0x3FF;
        this.scrollLatch = value;
        break;
        
      case PPU_REG.BG4VOFS:
        this.layers[3].vScroll = ((value << 8) | this.scrollLatch) & 0x3FF;
        this.scrollLatch = value;
        break;
        
      case PPU_REG.VMAIN:
        this.vramIncrement = [1, 32, 128, 128][value & 0x03];
        this.vramIncrementHigh = (value & 0x80) !== 0;
        break;
        
      case PPU_REG.VMADDL:
        this.vramAddress = (this.vramAddress & 0xFF00) | value;
        this.prefetchVRAM();
        break;
        
      case PPU_REG.VMADDH:
        this.vramAddress = (this.vramAddress & 0x00FF) | (value << 8);
        this.prefetchVRAM();
        break;
        
      case PPU_REG.VMDATAL:
        this.writeVRAMLow(value);
        break;
        
      case PPU_REG.VMDATAH:
        this.writeVRAMHigh(value);
        break;
        
      case PPU_REG.M7SEL:
        this.mode7.hFlip = (value & 0x01) !== 0;
        this.mode7.vFlip = (value & 0x02) !== 0;
        this.mode7.flipX = this.mode7.hFlip;
        this.mode7.flipY = this.mode7.vFlip;
        this.mode7.repeat = (value >> 6) & 0x03;
        break;
        
      case PPU_REG.M7A:
        this.mode7.a = this.signExtend16(((value << 8) | this.mode7Latch) & 0xFFFF);
        this.mode7Latch = value;
        this.updateMultiply();
        break;
        
      case PPU_REG.M7B:
        this.mode7.b = this.signExtend16(((value << 8) | this.mode7Latch) & 0xFFFF);
        this.mode7Latch = value;
        this.updateMultiply();
        break;
        
      case PPU_REG.M7C:
        this.mode7.c = this.signExtend16(((value << 8) | this.mode7Latch) & 0xFFFF);
        this.mode7Latch = value;
        break;
        
      case PPU_REG.M7D:
        this.mode7.d = this.signExtend16(((value << 8) | this.mode7Latch) & 0xFFFF);
        this.mode7Latch = value;
        break;
        
      case PPU_REG.M7X:
        this.mode7.centerX = this.signExtend13(((value << 8) | this.mode7Latch) & 0x1FFF);
        this.mode7Latch = value;
        break;
        
      case PPU_REG.M7Y:
        this.mode7.centerY = this.signExtend13(((value << 8) | this.mode7Latch) & 0x1FFF);
        this.mode7Latch = value;
        break;
        
      case PPU_REG.CGADD:
        this.cgramAddress = value;
        this.cgramLatch = false;
        break;
        
      case PPU_REG.CGDATA:
        this.writeCGRAM(value);
        break;
        
      case PPU_REG.W12SEL:
      case PPU_REG.W34SEL:
      case PPU_REG.WOBJSEL:
        // Window mask settings - stored for rendering
        if (address === PPU_REG.W12SEL) this.w12sel = value;
        if (address === PPU_REG.W34SEL) this.w34sel = value;
        break;
        
      case PPU_REG.WH0:
        this.window1Left = value;
        break;
        
      case PPU_REG.WH1:
        this.window1Right = value;
        break;
        
      case PPU_REG.WH2:
        this.window2Left = value;
        break;
        
      case PPU_REG.WH3:
        this.window2Right = value;
        break;
        
      case PPU_REG.TM:
        this.mainScreen = value;
        for (let i = 0; i < 4; i++) {
          this.layers[i].enabled = (value & (1 << i)) !== 0;
        }
        break;
        
      case PPU_REG.TS:
        this.subScreen = value;
        break;
        
      case PPU_REG.CGWSEL:
        // Color addition select
        this.cgwsel = value;
        break;
        
      case PPU_REG.CGADSUB:
        this.cgadsub = value;
        this.colorMathEnabled = value;
        break;
        
      case PPU_REG.COLDATA:
        // Fixed color for color math
        const intensity = value & 0x1F;
        if (value & 0x20) this.fixedColor = (this.fixedColor & 0x7FE0) | intensity;
        if (value & 0x40) this.fixedColor = (this.fixedColor & 0x7C1F) | (intensity << 5);
        if (value & 0x80) this.fixedColor = (this.fixedColor & 0x03FF) | (intensity << 10);
        break;
        
      case PPU_REG.SETINI:
        this.setini = value;
        this.overscan = (value & 0x04) !== 0;
        break;
    }
  }
  
  // ============================================================================
  // VRAM Access
  // ============================================================================
  
  private prefetchVRAM(): void {
    const addr = (this.vramAddress << 1) & 0xFFFF;
    this.vramReadBuffer = this.vram[addr] | (this.vram[addr + 1] << 8);
  }
  
  private readVRAMLow(): number {
    const value = this.vramReadBuffer & 0xFF;
    if (!this.vramIncrementHigh) {
      this.prefetchVRAM();
      this.vramAddress = (this.vramAddress + this.vramIncrement) & 0xFFFF;
    }
    return value;
  }
  
  private readVRAMHigh(): number {
    const value = (this.vramReadBuffer >> 8) & 0xFF;
    if (this.vramIncrementHigh) {
      this.prefetchVRAM();
      this.vramAddress = (this.vramAddress + this.vramIncrement) & 0xFFFF;
    }
    return value;
  }
  
  private writeVRAMLow(value: number): void {
    const addr = (this.vramAddress << 1) & 0xFFFF;
    this.vram[addr] = value;
    if (!this.vramIncrementHigh) {
      this.vramAddress = (this.vramAddress + this.vramIncrement) & 0xFFFF;
    }
  }
  
  private writeVRAMHigh(value: number): void {
    const addr = ((this.vramAddress << 1) + 1) & 0xFFFF;
    this.vram[addr] = value;
    if (this.vramIncrementHigh) {
      this.vramAddress = (this.vramAddress + this.vramIncrement) & 0xFFFF;
    }
  }
  
  // ============================================================================
  // OAM Access
  // ============================================================================
  
  private readOAM(): number {
    const value = this.oam[this.oamAddress];
    this.oamAddress = (this.oamAddress + 1) & 0x3FF;
    if (this.oamAddress >= 0x220) {
      this.oamAddress = 0;
    }
    return value;
  }
  
  private writeOAM(value: number): void {
    if (this.oamAddress < 0x200) {
      if (this.oamAddress & 1) {
        // High byte
        this.oam[this.oamAddress - 1] = this.oamWriteBuffer;
        this.oam[this.oamAddress] = value;
      } else {
        // Low byte - buffer
        this.oamWriteBuffer = value;
      }
    } else {
      // High table (extra bits)
      this.oam[this.oamAddress] = value;
    }
    this.oamAddress = (this.oamAddress + 1) & 0x3FF;
    if (this.oamAddress >= 0x220) {
      this.oamAddress = 0;
    }
  }
  
  // ============================================================================
  // CGRAM Access
  // ============================================================================
  
  private readCGRAM(): number {
    const value = this.cgram[this.cgramAddress * 2 + (this.cgramLatch ? 1 : 0)];
    if (this.cgramLatch) {
      this.cgramAddress = (this.cgramAddress + 1) & 0xFF;
    }
    this.cgramLatch = !this.cgramLatch;
    return value;
  }
  
  private writeCGRAM(value: number): void {
    if (!this.cgramLatch) {
      this.cgramWriteBuffer = value;
    } else {
      this.cgram[this.cgramAddress * 2] = this.cgramWriteBuffer;
      this.cgram[this.cgramAddress * 2 + 1] = value & 0x7F;
      this.cgramAddress = (this.cgramAddress + 1) & 0xFF;
    }
    this.cgramLatch = !this.cgramLatch;
  }
  
  // ============================================================================
  // Helper Functions
  // ============================================================================
  
  private signExtend13(value: number): number {
    if (value & 0x1000) {
      return value - 0x2000;
    }
    return value;
  }
  
  private signExtend16(value: number): number {
    if (value & 0x8000) {
      return value - 0x10000;
    }
    return value;
  }
  
  private updateLayerBPP(): void {
    switch (this.bgMode) {
      case BGMode.MODE_0:
        this.layers[0].bpp = 2;
        this.layers[1].bpp = 2;
        this.layers[2].bpp = 2;
        this.layers[3].bpp = 2;
        break;
      case BGMode.MODE_1:
        this.layers[0].bpp = 4;
        this.layers[1].bpp = 4;
        this.layers[2].bpp = 2;
        break;
      case BGMode.MODE_2:
      case BGMode.MODE_5:
      case BGMode.MODE_6:
        this.layers[0].bpp = 4;
        this.layers[1].bpp = 4;
        break;
      case BGMode.MODE_3:
        this.layers[0].bpp = 8;
        this.layers[1].bpp = 4;
        break;
      case BGMode.MODE_4:
        this.layers[0].bpp = 8;
        this.layers[1].bpp = 2;
        break;
      case BGMode.MODE_7:
        this.layers[0].bpp = 8;
        break;
    }
  }
  
  private updateMultiply(): void {
    // Mode 7 signed multiplication: M7A * (M7B >> 8)
    const a = this.mode7.a;
    const b = this.mode7.b >> 8;
    this.multiplyResult = a * b;
  }
  
  // ============================================================================
  // Rendering
  // ============================================================================
  
  /**
   * Step the PPU by specified number of dots (default 1)
   */
  step(dots: number = 1): void {
    for (let i = 0; i < dots; i++) {
      this.dot++;
      
      if (this.dot >= PPU_CONSTANTS.DOTS_PER_SCANLINE) {
        this.dot = 0;
        this.renderScanline();
        this.scanline++;
        
        // H-Blank callback
        if (this.onHBlank) {
          this.onHBlank();
        }
        
        const maxScanlines = this.isNTSC ? 
          PPU_CONSTANTS.SCANLINES_NTSC : 
          PPU_CONSTANTS.SCANLINES_PAL;
        
        if (this.scanline >= maxScanlines) {
          this.scanline = 0;
          this.frameCount++;
        }
        
        // V-Blank start
        const vblankStart = this.isNTSC ?
          PPU_CONSTANTS.VBLANK_START_NTSC :
          PPU_CONSTANTS.VBLANK_START_PAL;
        
        if (this.scanline === vblankStart && this.onVBlank) {
          this.onVBlank();
        }
      }
    }
  }
  
  /**
   * Render a single scanline
   */
  private renderScanline(): void {
    // Only render visible scanlines
    const screenHeight = this.overscan ? 239 : PPU_CONSTANTS.SCREEN_HEIGHT;
    if (this.scanline >= screenHeight) return;
    
    // Clear line buffers
    this.mainBuffer.fill(0);
    this.subBuffer.fill(this.fixedColor);
    this.priorityBuffer.fill(0);
    
    if (!this.displayEnabled) {
      // Screen is blanked - still need to write black to framebuffer
      this.compositeLine();
      return;
    }
    
    // Render based on mode
    if (this.bgMode === BGMode.MODE_7) {
      this.renderMode7Line();
    } else {
      this.renderBackgroundLayers();
    }
    
    // Render sprites
    if (this.mainScreen & 0x10) {
      this.renderSpriteLine();
    }
    
    // Apply color math and write to framebuffer
    this.compositeLine();
  }
  
  /**
   * Render background layers for current scanline
   */
  private renderBackgroundLayers(): void {
    // Render layers in priority order (back to front)
    for (let priority = 0; priority <= 1; priority++) {
      for (let layer = 3; layer >= 0; layer--) {
        if (!this.layers[layer].enabled) continue;
        
        // Check if this layer is active in current mode
        if (!this.isLayerActiveInMode(layer)) continue;
        
        this.renderBGLine(layer, priority);
      }
    }
  }
  
  private isLayerActiveInMode(layer: number): boolean {
    switch (this.bgMode) {
      case BGMode.MODE_0: return layer < 4;
      case BGMode.MODE_1: return layer < 3;
      case BGMode.MODE_2:
      case BGMode.MODE_3:
      case BGMode.MODE_4:
      case BGMode.MODE_5:
      case BGMode.MODE_6:
        return layer < 2;
      case BGMode.MODE_7: return layer === 0;
      default: return false;
    }
  }
  
  /**
   * Render one background layer for current scanline
   */
  private renderBGLine(layer: number, priority: number): void {
    const config = this.layers[layer];
    const y = (this.scanline + config.vScroll) & 0x3FF;
    
    const tileSize = config.tileSize;
    const tilemapRow = Math.floor(y / 8) & 0x1F;
    const tileY = y & 7;
    
    for (let x = 0; x < PPU_CONSTANTS.SCREEN_WIDTH; x++) {
      const screenX = (x + config.hScroll) & 0x3FF;
      const tilemapCol = Math.floor(screenX / 8) & 0x1F;
      const tileX = screenX & 7;
      
      // Get tile from tilemap
      const tilemapOffset = config.tilemapAddress + (tilemapRow * 32 + tilemapCol) * 2;
      const tileData = this.vram[tilemapOffset] | (this.vram[tilemapOffset + 1] << 8);
      
      const tileNumber = tileData & 0x3FF;
      const palette = (tileData >> 10) & 0x07;
      const tilePriority = (tileData >> 13) & 0x01;
      const hFlip = (tileData >> 14) & 0x01;
      const vFlip = (tileData >> 15) & 0x01;
      
      // Skip if priority doesn't match
      if (tilePriority !== priority) continue;
      
      // Get pixel color
      const px = hFlip ? (7 - tileX) : tileX;
      const py = vFlip ? (7 - tileY) : tileY;
      
      const color = this.getTilePixel(
        config.tileDataAddress,
        tileNumber,
        px, py,
        config.bpp
      );
      
      // Skip transparent pixels
      if (color === 0) continue;
      
      // Get actual color from palette
      const paletteOffset = (palette * (1 << config.bpp) + color) * 2;
      const rgb = this.cgram[paletteOffset] | (this.cgram[paletteOffset + 1] << 8);
      
      // Write to buffer if priority allows
      if (priority >= this.priorityBuffer[x]) {
        this.mainBuffer[x] = rgb;
        this.priorityBuffer[x] = priority + (layer << 2);
      }
    }
  }
  
  /**
   * Get a pixel from a tile in VRAM
   */
  private getTilePixel(baseAddr: number, tileNum: number, x: number, y: number, bpp: number): number {
    const bytesPerTile = bpp * 8; // 8 bytes per row * bpp / 8 bits
    const tileAddr = baseAddr + tileNum * bytesPerTile;
    const rowAddr = tileAddr + y * 2;
    
    let pixel = 0;
    
    // 2bpp: planes 0,1
    const bp0 = this.vram[rowAddr];
    const bp1 = this.vram[rowAddr + 1];
    pixel = ((bp0 >> (7 - x)) & 1) | (((bp1 >> (7 - x)) & 1) << 1);
    
    if (bpp >= 4) {
      // 4bpp: add planes 2,3
      const bp2 = this.vram[rowAddr + 16];
      const bp3 = this.vram[rowAddr + 17];
      pixel |= (((bp2 >> (7 - x)) & 1) << 2) | (((bp3 >> (7 - x)) & 1) << 3);
    }
    
    if (bpp === 8) {
      // 8bpp: add planes 4,5,6,7
      const bp4 = this.vram[rowAddr + 32];
      const bp5 = this.vram[rowAddr + 33];
      const bp6 = this.vram[rowAddr + 48];
      const bp7 = this.vram[rowAddr + 49];
      pixel |= (((bp4 >> (7 - x)) & 1) << 4) | (((bp5 >> (7 - x)) & 1) << 5) |
               (((bp6 >> (7 - x)) & 1) << 6) | (((bp7 >> (7 - x)) & 1) << 7);
    }
    
    return pixel;
  }
  
  /**
   * Render Mode 7 (affine transformation) for current scanline
   */
  private renderMode7Line(): void {
    const y = this.scanline;
    const m7 = this.mode7;
    
    // Apply screen flip
    const screenY = m7.vFlip ? (PPU_CONSTANTS.SCREEN_HEIGHT - 1 - y) : y;
    
    for (let x = 0; x < PPU_CONSTANTS.SCREEN_WIDTH; x++) {
      const screenX = m7.hFlip ? (PPU_CONSTANTS.SCREEN_WIDTH - 1 - x) : x;
      
      // Apply Mode 7 transformation
      // x' = A*(x-cx) + B*(y-cy) + cx + hscroll
      // y' = C*(x-cx) + D*(y-cy) + cy + vscroll
      const dx = screenX - m7.centerX;
      const dy = screenY - m7.centerY;
      
      let texX = Math.floor((m7.a * dx + m7.b * dy) / 256) + m7.centerX + m7.hScroll;
      let texY = Math.floor((m7.c * dx + m7.d * dy) / 256) + m7.centerY + m7.vScroll;
      
      // Handle out-of-bounds based on repeat mode
      let color = 0;
      
      if (texX < 0 || texX >= 1024 || texY < 0 || texY >= 1024) {
        switch (m7.repeat) {
          case 0: // Wrap
            texX &= 0x3FF;
            texY &= 0x3FF;
            break;
          case 1: // Transparent
            this.mainBuffer[x] = 0;
            continue;
          case 2: // Tile 0
            texX = 0;
            texY = 0;
            break;
          case 3: // Character 0 repeat
            texX &= 0x3FF;
            texY &= 0x3FF;
            if (texX >= 128 || texY >= 128) {
              texX = 0;
              texY = 0;
            }
            break;
        }
      }
      
      // Mode 7 tilemap is 128x128 tiles at start of VRAM
      const tileX = texX >> 3;
      const tileY = texY >> 3;
      const pixelX = texX & 7;
      const pixelY = texY & 7;
      
      // Tilemap entry (low byte of each word)
      const tileNum = this.vram[(tileY * 128 + tileX) * 2];
      
      // Tile pixel (high byte of each word in character data)
      const charAddr = (tileNum * 64 + pixelY * 8 + pixelX) * 2 + 1;
      color = this.vram[charAddr];
      
      if (color === 0) continue;
      
      // Get color from palette
      const rgb = this.cgram[color * 2] | (this.cgram[color * 2 + 1] << 8);
      this.mainBuffer[x] = rgb;
      this.priorityBuffer[x] = 4; // Mode 7 has single priority
    }
  }
  
  /**
   * Render sprites for current scanline
   */
  private renderSpriteLine(): void {
    const sprites = this.getSpritesOnLine();
    const sizes = SPRITE_SIZES[this.spriteSizeIndex];
    
    // Render in reverse order (lower indices have higher priority)
    for (let i = sprites.length - 1; i >= 0; i--) {
      const sprite = sprites[i];
      const [w, h] = sprite.size ? sizes[1] : sizes[0];
      
      const baseX = sprite.x >= 256 ? sprite.x - 512 : sprite.x;
      const rowInSprite = this.scanline - sprite.y;
      const srcY = sprite.vFlip ? (h - 1 - rowInSprite) : rowInSprite;
      
      for (let sx = 0; sx < w; sx++) {
        const screenX = baseX + sx;
        if (screenX < 0 || screenX >= PPU_CONSTANTS.SCREEN_WIDTH) continue;
        
        const srcX = sprite.hFlip ? (w - 1 - sx) : sx;
        
        // Get tile for this part of the sprite
        const tileCol = Math.floor(srcX / 8);
        const tileRow = Math.floor(srcY / 8);
        const tileNum = sprite.tile + tileCol + tileRow * 16;
        
        // Get pixel
        const tileAddr = this.spriteBaseAddress + 
          (sprite.nameTable ? this.spriteNameSelect : 0) + tileNum * 32;
        const color = this.getTilePixel(tileAddr, 0, srcX & 7, srcY & 7, 4);
        
        if (color === 0) continue;
        
        // Sprite palette starts at 128
        const paletteOffset = (128 + sprite.palette * 16 + color) * 2;
        const rgb = this.cgram[paletteOffset] | (this.cgram[paletteOffset + 1] << 8);
        
        // Check priority
        const spritePriority = sprite.priority + 8;
        if (spritePriority >= this.priorityBuffer[screenX]) {
          this.mainBuffer[screenX] = rgb;
          this.priorityBuffer[screenX] = spritePriority;
        }
      }
    }
  }
  
  /**
   * Get sprites visible on current scanline
   */
  private getSpritesOnLine(): SpriteEntry[] {
    const sprites: SpriteEntry[] = [];
    const sizes = SPRITE_SIZES[this.spriteSizeIndex];
    
    for (let i = 0; i < 128; i++) {
      const baseAddr = i * 4;
      
      // Low table
      const x = this.oam[baseAddr];
      const y = this.oam[baseAddr + 1];
      const tile = this.oam[baseAddr + 2];
      const attr = this.oam[baseAddr + 3];
      
      // High table
      const highByte = this.oam[0x200 + (i >> 2)];
      const shift = (i & 3) * 2;
      const xHigh = (highByte >> shift) & 1;
      const sizeFlag = (highByte >> (shift + 1)) & 1;
      
      const fullX = x | (xHigh << 8);
      const [, h] = sizeFlag ? sizes[1] : sizes[0];
      
      // Check if sprite is on this scanline
      const spriteY = y;
      const spriteBottom = (spriteY + h) & 0xFF;
      
      // Handle Y wrapping
      let onLine = false;
      if (spriteY <= this.scanline && this.scanline < spriteY + h) {
        onLine = true;
      }
      
      if (!onLine) continue;
      
      sprites.push({
        x: fullX,
        y: spriteY,
        tile: tile,
        nameTable: (attr >> 0) & 1,
        palette: (attr >> 1) & 7,
        priority: (attr >> 4) & 3,
        hFlip: (attr >> 6) & 1 ? true : false,
        vFlip: (attr >> 7) & 1 ? true : false,
        size: sizeFlag ? true : false,
      });
      
      // Max 32 sprites per line
      if (sprites.length >= 32) break;
    }
    
    return sprites;
  }
  
  /**
   * Composite main and sub screens with color math
   */
  private compositeLine(): void {
    const offset = this.scanline * PPU_CONSTANTS.SCREEN_WIDTH;
    
    for (let x = 0; x < PPU_CONSTANTS.SCREEN_WIDTH; x++) {
      let color = this.mainBuffer[x];
      
      // Apply brightness
      if (this.brightness < 0x0F) {
        const r = ((color & 0x1F) * this.brightness) >> 4;
        const g = (((color >> 5) & 0x1F) * this.brightness) >> 4;
        const b = (((color >> 10) & 0x1F) * this.brightness) >> 4;
        color = r | (g << 5) | (b << 10);
      }
      
      this.framebuffer[offset + x] = color;
    }
  }
  
  // ============================================================================
  // Public Interface
  // ============================================================================
  
  setVBlankCallback(callback: () => void): void {
    this.onVBlank = callback;
  }
  
  setHBlankCallback(callback: () => void): void {
    this.onHBlank = callback;
  }
  
  getFramebuffer(): Uint16Array {
    return this.framebuffer;
  }
  
  /**
   * Get RGBA framebuffer for rendering
   */
  getFrameBuffer(): Uint8ClampedArray {
    const rgba = new Uint8ClampedArray(
      PPU_CONSTANTS.SCREEN_WIDTH * PPU_CONSTANTS.SCREEN_HEIGHT * 4
    );
    
    for (let i = 0; i < this.framebuffer.length; i++) {
      const color15 = this.framebuffer[i];
      const r = ((color15 & 0x1F) * 255 / 31) | 0;
      const g = (((color15 >> 5) & 0x1F) * 255 / 31) | 0;
      const b = (((color15 >> 10) & 0x1F) * 255 / 31) | 0;
      
      rgba[i * 4 + 0] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
    }
    
    return rgba;
  }
  
  /**
   * Get debug info for PPU state
   */
  getDebugInfo(): any {
    return {
      displayEnabled: this.displayEnabled,
      brightness: this.brightness,
      bgMode: this.bgMode,
      mainScreen: this.mainScreen,
      subScreen: this.subScreen,
      layers: this.layers.map(l => ({ enabled: l.enabled })),
      frameCount: this.frameCount,
      scanline: this.scanline,
      dot: this.dot,
    };
  }

  getScanline(): number {
    return this.scanline;
  }
  
  getDot(): number {
    return this.dot;
  }
  
  getFrameCount(): number {
    return this.frameCount;
  }
  
  isInVBlank(): boolean {
    const vblankStart = this.isNTSC ?
      PPU_CONSTANTS.VBLANK_START_NTSC :
      PPU_CONSTANTS.VBLANK_START_PAL;
    return this.scanline >= vblankStart;
  }
  
  /**
   * Check if currently in HBlank period (dots 274-340)
   */
  isInHBlank(): boolean {
    return this.dot >= 274;
  }
  
  /**
   * Check if NMI is enabled
   * Note: In real hardware this is controlled by NMITIMEN ($4200)
   * For simplicity, we always return true here - proper implementation
   * would track the register state
   */
  isNMIEnabled(): boolean {
    return true; // Simplified - always allow NMI
  }

  isForceBlank(): boolean {
    return !this.displayEnabled;
  }
  
  setNTSC(ntsc: boolean): void {
    this.isNTSC = ntsc;
  }
  
  /**
   * Get current PPU state for tests and debugging
   */
  getState(): PPUState {
    return {
      vram: new Uint8Array(this.vram),
      oam: new Uint8Array(this.oam),
      cgram: new Uint8Array(this.cgram),
      registers: new Uint8Array(0),
      scanline: this.scanline,
      dot: this.dot,
      frameCount: this.frameCount,
      mode7: { ...this.mode7 },
      inidisp: this.inidisp,
      obsel: this.obsel,
      bgmode: this.bgMode | (this.bg3Priority ? 0x08 : 0),
      bg1sc: this.bg1sc,
      bg2sc: this.bg2sc,
      bg3sc: this.bg3sc,
      bg4sc: this.bg4sc,
      tm: this.mainScreen,
      ts: this.subScreen,
      oamAddr: this.oamAddress,
      window1Left: this.window1Left,
      window1Right: this.window1Right,
      window2Left: this.window2Left,
      window2Right: this.window2Right,
      w12sel: this.w12sel,
      w34sel: this.w34sel,
      cgwsel: this.cgwsel,
      cgadsub: this.cgadsub,
      fixedColor: this.fixedColor,
      setini: this.setini,
    };
  }
  
  // ============================================================================
  // State Management
  // ============================================================================
  
  saveState(): PPUState {
    return this.getState();
  }
  
  loadState(state: PPUState): void {
    this.vram.set(state.vram);
    this.oam.set(state.oam);
    this.cgram.set(state.cgram);
    this.scanline = state.scanline;
    this.dot = state.dot;
    this.frameCount = state.frameCount;
    this.mode7 = { ...state.mode7 };
    
    // Restore register states if present
    if (state.inidisp !== undefined) {
      this.inidisp = state.inidisp;
      this.displayEnabled = (state.inidisp & 0x80) === 0;
      this.brightness = state.inidisp & 0x0F;
    }
    if (state.bgmode !== undefined) {
      this.bgMode = (state.bgmode & 0x07) as BGMode;
      this.bg3Priority = (state.bgmode & 0x08) !== 0;
    }
    if (state.tm !== undefined) this.mainScreen = state.tm;
    if (state.ts !== undefined) this.subScreen = state.ts;
    if (state.bg1sc !== undefined) this.bg1sc = state.bg1sc;
    if (state.bg2sc !== undefined) this.bg2sc = state.bg2sc;
    if (state.bg3sc !== undefined) this.bg3sc = state.bg3sc;
    if (state.bg4sc !== undefined) this.bg4sc = state.bg4sc;
    if (state.window1Left !== undefined) this.window1Left = state.window1Left;
    if (state.window1Right !== undefined) this.window1Right = state.window1Right;
    if (state.window2Left !== undefined) this.window2Left = state.window2Left;
    if (state.window2Right !== undefined) this.window2Right = state.window2Right;
    if (state.w12sel !== undefined) this.w12sel = state.w12sel;
    if (state.w34sel !== undefined) this.w34sel = state.w34sel;
    if (state.cgwsel !== undefined) this.cgwsel = state.cgwsel;
    if (state.cgadsub !== undefined) this.cgadsub = state.cgadsub;
    if (state.fixedColor !== undefined) this.fixedColor = state.fixedColor;
    if (state.setini !== undefined) {
      this.setini = state.setini;
      this.overscan = (state.setini & 0x04) !== 0;
    }
  }
}
