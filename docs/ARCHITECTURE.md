# Project 16-bit: SFC Emulator Architecture

## 📋 Overview

A high-fidelity Super Famicom emulator targeting perfect compatibility with classic titles through accurate hardware emulation and an extensible enhancement chip plugin system.

---

## 🎯 Target Games & Required Features

| Game | Key Requirements |
|------|------------------|
| Final Fantasy VI | Mode 7, Complex scripting |
| Super Mario RPG | **SA-1 chip**, Advanced graphics |
| Seiken Densetsu 2/3 | Precise timing, Audio sync |
| Super Mario Kart | **DSP-1 chip**, Mode 7 affine |
| Mega Man X | High-speed sprites, Collision |
| Chrono Trigger | IRQ handling, Layer effects |

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         SNES System                              │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   65C816    │  │    PPU      │  │         APU             │  │
│  │    CPU      │◄─►│  (Video)   │  │  ┌─────────┐ ┌───────┐  │  │
│  │  3.58 MHz   │  │  Mode 0-7   │  │  │ SPC700  │ │  DSP  │  │  │
│  └──────┬──────┘  └──────┬──────┘  │  │ CPU     │ │ Audio │  │  │
│         │                │         │  └─────────┘ └───────┘  │  │
│         ▼                ▼         └─────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Memory Bus                             │   │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────────┐   │   │
│  │  │ WRAM   │ │ VRAM   │ │  OAM   │ │  Cartridge ROM   │   │   │
│  │  │ 128KB  │ │ 64KB   │ │ 544B   │ │  + SRAM + Chips  │   │   │
│  │  └────────┘ └────────┘ └────────┘ └──────────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ▲                                   │
│                              │                                   │
│  ┌───────────────────────────┴──────────────────────────────┐   │
│  │           Enhancement Chip Plugin System                  │   │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐  │   │
│  │  │  SA-1  │ │ DSP-1  │ │SuperFX │ │  Cx4   │ │  OBC1  │  │   │
│  │  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔌 Enhancement Chip Plugin Architecture

### Plugin Interface Design

```typescript
interface EnhancementChip {
  readonly name: string;
  readonly identifier: ChipType;
  
  // Lifecycle
  init(rom: Uint8Array, sram: Uint8Array): void;
  reset(): void;
  
  // Memory mapping
  read(bank: number, address: number): number;
  write(bank: number, address: number, value: number): void;
  
  // Execution
  step(masterCycles: number): void;
  
  // State management
  saveState(): ChipState;
  loadState(state: ChipState): void;
}
```

### Auto-Detection from ROM Header

```typescript
// ROM Header @ $00FFD5-$00FFD6 contains chip info
const CHIP_DETECTION_MAP = {
  0x23: ChipType.SA1,      // SA-1
  0x03: ChipType.DSP1,     // DSP-1
  0x15: ChipType.SuperFX,  // Super FX
  0x25: ChipType.OBC1,     // OBC1
  0xF3: ChipType.CX4,      // Cx4
};
```

---

## 🧪 Testing Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    CI/CD Testing Pipeline                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Stage 1: Unit Tests                                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  • CPU instruction tests (TomHarte test suite)       │   │
│  │  • ALU operation validation                          │   │
│  │  • Memory mapping verification                       │   │
│  └──────────────────────────────────────────────────────┘   │
│                         ▼                                    │
│  Stage 2: Component Integration                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  • PPU scanline rendering tests                      │   │
│  │  • APU/SPC700 audio sync tests                       │   │
│  │  • DMA/HDMA transfer validation                      │   │
│  └──────────────────────────────────────────────────────┘   │
│                         ▼                                    │
│  Stage 3: Enhancement Chip Tests                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  • SA-1 math operations                              │   │
│  │  • DSP-1 matrix calculations                         │   │
│  │  • Chip memory mapping                               │   │
│  └──────────────────────────────────────────────────────┘   │
│                         ▼                                    │
│  Stage 4: ROM Compatibility Tests                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  • Test ROM execution (blargg, PeterLemon)           │   │
│  │  • Frame comparison / golden image tests             │   │
│  │  • Audio waveform verification                       │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 📊 Timing & Synchronization Model

| Component | Clock Speed | Cycles/Scanline |
|-----------|-------------|-----------------|
| Main CPU | 3.58 MHz (NTSC) | 1364 |
| APU (SPC700) | 1.024 MHz | ~389 |
| PPU | 5.37 MHz | 341 dots |

### Synchronization Strategy
- **Cycle-accurate**: CPU ↔ PPU (required for raster effects)
- **Catch-up**: APU runs ahead then syncs at frame boundaries
- **Event-driven**: IRQ/NMI timing via priority queue

