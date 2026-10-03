// Maps Tailwind theme keys to the --cp-* custom properties so existing classes follow the active theme.
const v = (name: string) => `var(--cp-${name})`;

export const cpPreset = {
  theme: {
    extend: {
      colors: {
        bg: v("bg"), "bg-2": v("bg-2"), "bg-3": v("bg-3"), card: v("card"), hover: v("hover"),
        text: v("text"), "text-2": v("text-2"), muted: v("text-muted"), inverse: v("text-inverse"),
        border: v("border"), "border-light": v("border-light"),
        accent: v("accent"), "accent-hover": v("accent-hover"), "accent-active": v("accent-active"),
        "accent-muted": v("accent-muted"),
        success: v("success"), warning: v("warning"), error: v("error"), info: v("info"),
        opus: v("opus"), sonnet: v("sonnet"), haiku: v("haiku"),
      },
      borderRadius: {
        sm: v("radius-sm"), md: v("radius-md"), lg: v("radius-lg"), nav: v("radius-nav"), full: v("radius-full"),
      },
      spacing: {
        "cp-xs": v("space-xs"), "cp-sm": v("space-sm"), "cp-md": v("space-md"), "cp-lg": v("space-lg"),
        "cp-xl": v("space-xl"), "cp-2xl": v("space-2xl"), "cp-3xl": v("space-3xl"),
      },
      fontFamily: {
        serif: [v("font-serif")], sans: [v("font-sans")], mono: [v("font-mono")],
      },
      fontSize: {
        "cp-xs": v("text-xs"), "cp-sm": v("text-sm"), "cp-base": v("text-base"), "cp-md": v("text-md"),
        "cp-lg": v("text-lg"), "cp-xl": v("text-xl"), "cp-2xl": v("text-2xl"), "cp-3xl": v("text-3xl"),
      },
      boxShadow: { sm: v("shadow-sm"), md: v("shadow-md"), lg: v("shadow-lg"), focus: v("focus") },
      screens: { sm: "640px", md: "768px", lg: "1024px", xl: "1280px", "2xl": "1536px" },
    },
  },
};

export default cpPreset;
