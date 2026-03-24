# PRD: Browser Game

## Overview
A browser-based 2D game with player controls, enemy AI, scoring, levels, and persistent high scores. Runs entirely client-side with no server required.

## Target Users
- Casual gamers looking for a quick browser-based experience
- Game developers learning 2D game architecture patterns
- Developers exploring canvas-based rendering and game loops

## Core Features
1. **Player Controls** - Keyboard input for movement and actions with configurable key bindings
2. **Game Loop** - Fixed-timestep update loop with requestAnimationFrame rendering at 60fps
3. **Enemy AI** - Multiple enemy types with distinct movement patterns and difficulty scaling
4. **Collision Detection** - Axis-aligned bounding box (AABB) collision between sprites
5. **Scoring and Levels** - Point system with level progression, increasing difficulty per level
6. **High Scores** - Persistent leaderboard stored in localStorage with name entry
7. **Sound Effects** - Audio feedback for actions, collisions, and level completion using Web Audio API

## Technical Requirements
- HTML5 Canvas for rendering
- Vanilla TypeScript (no game engine dependency)
- Web Audio API for sound
- LocalStorage for high scores and settings
- Asset pipeline for sprites and audio files
- Responsive canvas sizing
- No server required (static files only)

## Quality Gates
- Unit tests for collision detection, scoring, and level progression logic
- Game loop maintains consistent frame timing under load
- All sprite assets load without errors
- Controls responsive on both keyboard and touch (mobile)
- No memory leaks during extended play sessions

## Project Structure
```
/
├── src/
│   ├── engine/
│   │   ├── game.ts            # Main game loop and state machine
│   │   ├── renderer.ts        # Canvas rendering layer
│   │   ├── input.ts           # Keyboard and touch input handler
│   │   └── audio.ts           # Web Audio API wrapper
│   ├── entities/
│   │   ├── player.ts          # Player sprite and controls
│   │   ├── enemy.ts           # Enemy types and AI patterns
│   │   └── projectile.ts      # Bullets and projectiles
│   ├── systems/
│   │   ├── collision.ts       # AABB collision detection
│   │   ├── scoring.ts         # Score and level progression
│   │   └── highscores.ts      # LocalStorage leaderboard
│   ├── assets/
│   │   ├── sprites/           # Sprite images
│   │   └── sounds/            # Sound effect files
│   ├── main.ts                # Entry point
│   └── config.ts              # Game constants and key bindings
├── tests/
│   ├── collision.test.ts      # Collision detection tests
│   └── scoring.test.ts        # Score and level logic tests
├── index.html
├── package.json
└── README.md
```

## Out of Scope
- Multiplayer or networked gameplay
- 3D rendering or WebGL
- Level editor or user-generated content
- Achievements or progression system beyond levels
- Mobile app packaging (Capacitor, Electron)
- Analytics or telemetry
- In-app purchases or monetization

## Acceptance Criteria
- Game transitions through menu, playing, paused, and game-over states
- Player movement responds within one frame of input
- At least three enemy types exhibit distinct movement patterns
- Collision detection correctly identifies overlapping sprites
- Score increases on enemy defeat and displays on screen
- High score table persists across browser sessions
- Sound effects play on collision, shoot, and level-up events

## Success Metrics
- Game starts, plays, and ends with proper state transitions
- Player can move, shoot, and interact with enemies
- Score increments correctly and persists in high score table
- Level progression increases difficulty noticeably
- Game runs at stable 60fps on modern browsers
- All tests pass

---

**Purpose:** Tests Loki Mode's ability to build a browser game with canvas rendering, game loop architecture, enemy AI, collision detection, and audio. Expect ~30-45 minutes for full execution.
