// loki-ts/src/engine10/modernize/targets/java21.ts -- M-19: Java 8 to 21 strangler target
// (docs/v10/MODERNIZE.md section 8). Route status is the compiler release per module; the target
// module writes it into that module's Maven or Gradle build file.
import type { BuildSystemName } from "../inventory.ts";
import type { RouteMap } from "../routes.ts";

export const JAVA_ROUTE_STATUSES = ["8", "21"] as const;
export type JavaRouteStatus = (typeof JAVA_ROUTE_STATUSES)[number];

/** The compiler release a module's current route claims. No route yet defaults to 8 (nothing
 *  has moved off the old release). */
export function releaseForModule(routes: RouteMap, moduleId: string): JavaRouteStatus {
  return (routes[moduleId]?.status as JavaRouteStatus | undefined) ?? "8";
}

const MAVEN_RELEASE_RE = /<maven\.compiler\.release>\s*\d+\s*<\/maven\.compiler\.release>/;
const GRADLE_RELEASE_RE = /options\.release\.set\(\s*\d+\s*\)/;

/** Patches (or inserts) the module's compiler release into its build file content. Pure string
 *  transform: no file I/O here, the caller owns reading/writing the actual pom.xml/build.gradle. */
export function patchBuildFileRelease(system: BuildSystemName, content: string, release: JavaRouteStatus): string {
  if (system === "maven") {
    if (MAVEN_RELEASE_RE.test(content)) {
      return content.replace(MAVEN_RELEASE_RE, `<maven.compiler.release>${release}</maven.compiler.release>`);
    }
    if (content.includes("</properties>")) {
      return content.replace("</properties>", `  <maven.compiler.release>${release}</maven.compiler.release>\n</properties>`);
    }
    return content.replace("</project>", `  <properties>\n    <maven.compiler.release>${release}</maven.compiler.release>\n  </properties>\n</project>`);
  }
  if (system === "gradle") {
    if (GRADLE_RELEASE_RE.test(content)) return content.replace(GRADLE_RELEASE_RE, `options.release.set(${release})`);
    return `${content}\ntasks.withType(JavaCompile) {\n  options.release.set(${release})\n}\n`;
  }
  return content; // not a Java build system: leave untouched
}
