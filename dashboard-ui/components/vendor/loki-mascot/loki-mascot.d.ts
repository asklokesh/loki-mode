/**
 * Type surface for the <loki-mascot> custom element.
 *
 * Importing "@autonomi/loki-mascot" runs the module for its side effect: it
 * registers the <loki-mascot> custom element. This file augments the JSX/HTML
 * type maps so consumers (the React SPA, Astro marketing, etc.) can use the tag
 * with type checking once the retrofit step wires it in.
 */

export type LokiEmotion =
  | "idle"
  | "happy"
  | "thinking"
  | "building"
  | "reviewing"
  | "verifying"
  | "celebrating"
  | "proud"
  | "waving"
  | "sleeping"
  | "concerned"
  | "shipping"
  | "loading"
  | "curious"
  | "blinking"
  | "walking"
  | "running";

export type LokiMotion =
  | "breathe"
  | "bob"
  | "bounce"
  | "wiggle"
  | "tilt"
  | "work"
  | "inspect"
  | "shake"
  | "launch"
  | "wave"
  | "sleep"
  | "walk"
  | "run";

/** The custom element class. `.emotions` lists every registered emotion. */
export interface LokiMascotElement extends HTMLElement {
  emotion: LokiEmotion | string;
  size: string;
  motion: LokiMotion | string;
}

export interface LokiMascotConstructor {
  new (): LokiMascotElement;
  readonly emotions: string[];
}

declare global {
  interface HTMLElementTagNameMap {
    "loki-mascot": LokiMascotElement;
  }

  namespace JSX {
    interface IntrinsicElements {
      "loki-mascot": {
        emotion?: LokiEmotion | string;
        size?: string | number;
        motion?: LokiMotion | string;
        class?: string;
        className?: string;
        style?: unknown;
        title?: string;
      };
    }
  }
}

export {};
