import { Cards } from "./Cards";
import { Hero } from "./Hero";

/** Composer first, then the session cards. */
export function HomeStart() {
  return (
    <div data-testid="home-start">
      <Hero />
      <Cards />
    </div>
  );
}

export const page = { id: "home", path: "/home", title: "Home", component: HomeStart };
