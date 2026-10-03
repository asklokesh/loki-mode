import { Home } from "./Home";
import { Hero } from "./Hero";

/** Composer first, then the existing overview. */
export function HomeStart() {
  return (
    <div data-testid="home-start">
      <Hero />
      <Home />
    </div>
  );
}

export const page = { id: "home", path: "/home", title: "Home", component: HomeStart };
