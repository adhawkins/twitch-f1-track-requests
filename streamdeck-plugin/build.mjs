import "./scripts/generate-plugin-icons.mjs";
import { build } from "esbuild";

await build({
	entryPoints: ["src/plugin.ts"],
	outfile: "com.gently.f1-track-requests.sdPlugin/bin/plugin.js",
	bundle: true,
	platform: "node",
	target: "node24",
	format: "cjs",
});
