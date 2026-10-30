import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_XAI_BASE_URL, generateXaiVideo, sanitizeMessage, type XaiCredentials } from "./src/xai";

const DEFAULT_MODEL = "grok-imagine-video";
/** xAI serves 1080p only as image-to-video on this model. */
const HD_MODEL = "grok-imagine-video-1.5";
/** `xai-video` is a models.yml provider reserved for this tool, so a relay can serve video without rerouting xAI chat. */
const XAI_PROVIDERS = ["xai-video", "xai", "xai-oauth"] as const;

const DESCRIPTION = [
	"Generate a short video with xAI Grok Imagine and save it as an MP4 file.",
	"Each call submits a paid generation job (billed per output second); call it once per requested video and never retry a call that reported a job id.",
	"Text-to-video by default; pass `image` to animate a still as the first frame.",
	"On xAI, 1080p is image-to-video only (served by grok-imagine-video-1.5); omitted options use xAI's own defaults.",
	"Generation usually takes 20 seconds to a few minutes.",
].join("\n");

interface VideoToolDetails {
	provider?: string;
	model?: string;
	jobId?: string;
	path?: string;
	bytes?: number;
	costUsd?: number;
	videoUrl?: string;
}

function textResult(text: string, details: VideoToolDetails, isError = false) {
	return { content: [{ type: "text" as const, text }], details, ...(isError && { isError: true }) };
}

function expandPath(input: string, cwd: string): string {
	const home = os.homedir();
	if (input === "~") return home;
	if (input.startsWith("~/")) return path.join(home, input.slice(2));
	return path.resolve(cwd, input);
}

function displayPath(absolute: string, cwd: string): string {
	const relative = path.relative(cwd, absolute);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
	const home = os.homedir();
	return absolute.startsWith(`${home}${path.sep}`) ? `~${absolute.slice(home.length)}` : absolute;
}

function sniffImageMime(bytes: Uint8Array): string | undefined {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	if (bytes.length >= 12 && tag(0) === "RIFF" && tag(8) === "WEBP") return "image/webp";
	return undefined;
}

/** Turns the `image` argument into a URL xAI accepts: https as-is, local files inlined as data URLs. */
async function resolveImage(input: string, cwd: string): Promise<string> {
	if (/^https?:\/\//i.test(input)) return input;
	if (input.startsWith("data:")) {
		if (/^data:image\/(png|jpeg|webp);base64,/i.test(input)) return input;
		throw new Error("image data URLs must be base64 PNG, JPEG, or WebP");
	}
	const file = expandPath(input, cwd);
	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(file).bytes();
	} catch (error) {
		throw new Error(`cannot read image ${displayPath(file, cwd)}: ${sanitizeMessage(String(error))}`);
	}
	const mime = sniffImageMime(bytes);
	if (!mime) throw new Error(`image ${displayPath(file, cwd)} is not a PNG, JPEG, or WebP file`);
	return `data:${mime};base64,${Buffer.from(bytes).toBase64()}`;
}

async function resolveCredentials(
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<XaiCredentials | undefined> {
	for (const provider of XAI_PROVIDERS) {
		const key = await ctx.modelRegistry.getApiKeyForProvider(provider, undefined, { signal });
		if (!key) continue;
		const baseUrl = ctx.modelRegistry.getProviderBaseUrl(provider) ?? DEFAULT_XAI_BASE_URL;
		// Official xAI OAuth tokens must not leave api.x.ai.
		if (provider === "xai-oauth" && new URL(baseUrl).origin !== new URL(DEFAULT_XAI_BASE_URL).origin) continue;
		return {
			provider,
			baseUrl,
			async getKey(rejected) {
				const next = await ctx.modelRegistry.getApiKeyForProvider(provider, undefined, {
					signal,
					...(rejected !== undefined && { forceRefresh: true }),
				});
				return next ?? rejected ?? key;
			},
		};
	}
	return undefined;
}

export default function xaiVideoExtension(pi: ExtensionAPI) {
	// The typebox builder, unlike pi.zod, lets the host's ToolDefinition infer `params`.
	const T = pi.typebox.Type;

	pi.registerTool({
		name: "xai_generate_video",
		label: "xAI Video",
		description: DESCRIPTION,
		parameters: T.Object({
			prompt: T.String({ description: "What the video should show, including motion and camera direction." }),
			image: T.Optional(
				T.String({
					description: "First frame for image-to-video: an https URL, a data URL, or a local PNG/JPEG/WebP path.",
				}),
			),
			duration: T.Optional(T.Integer({ minimum: 1, maximum: 15, description: "Length in whole seconds (1-15)." })),
			aspect_ratio: T.Optional(T.Enum(["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"])),
			resolution: T.Optional(T.Enum(["480p", "720p", "1080p"])),
			model: T.Optional(T.String({ description: `xAI video model id. Defaults to ${DEFAULT_MODEL}.` })),
			output_path: T.Optional(
				T.String({
					description: "Where to save the MP4, relative to the working directory. Defaults to xai-video-<job>.mp4.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			let model = params.model;
			if (!model && params.resolution === "1080p") {
				if (!params.image) {
					return textResult(
						"1080p on xAI is image-to-video only; pass `image` or choose 720p. Nothing was submitted.",
						{},
						true,
					);
				}
				model = HD_MODEL;
			}
			model ??= DEFAULT_MODEL;

			let outputPath: string | undefined;
			if (params.output_path !== undefined) {
				if (params.output_path.trim() === "" || params.output_path.endsWith("/")) {
					return textResult("output_path must name a file, not a directory. Nothing was submitted.", {}, true);
				}
				outputPath = expandPath(params.output_path, ctx.cwd);
				const existing = await fs.stat(outputPath).catch(() => undefined);
				if (existing?.isDirectory()) {
					return textResult(
						`output_path ${displayPath(outputPath, ctx.cwd)} is a directory. Nothing was submitted.`,
						{},
						true,
					);
				}
			}

			let imageUrl: string | undefined;
			try {
				imageUrl = params.image === undefined ? undefined : await resolveImage(params.image, ctx.cwd);
			} catch (error) {
				return textResult(`${(error as Error).message}. Nothing was submitted.`, {}, true);
			}

			const credentials = await resolveCredentials(ctx, signal);
			if (!credentials) {
				return textResult(
					"No xAI credentials are configured in omp (a `xai-video` provider in models.yml, a `xai` API key, or an `xai-oauth` login). Nothing was submitted.",
					{},
					true,
				);
			}

			const startedAt = Date.now();
			const progress = (text: string, details: VideoToolDetails) => onUpdate?.(textResult(text, details));
			const outcome = await generateXaiVideo(
				credentials,
				{
					model,
					prompt: params.prompt,
					duration: params.duration,
					aspectRatio: params.aspect_ratio,
					resolution: params.resolution,
					imageUrl,
				},
				{
					signal,
					onSubmitted: jobId => progress(`xAI job ${jobId} submitted; generating…`, { jobId, model }),
					onProgress: (jobId, status, elapsedMs) =>
						progress(`xAI job ${jobId}: ${sanitizeMessage(status)} (${Math.round(elapsedMs / 1000)}s)`, {
							jobId,
							model,
						}),
				},
			);
			const base: VideoToolDetails = { provider: credentials.provider, model };

			if (outcome.kind === "not-submitted") {
				return textResult(`${outcome.message} No job was created.`, base, true);
			}
			const cost = outcome.costUsd === undefined ? "" : ` Cost: $${outcome.costUsd.toFixed(4)}.`;
			if (outcome.kind === "job-failed") {
				const recovery = outcome.videoUrl ? ` The video is still downloadable at ${outcome.videoUrl}` : "";
				return textResult(
					`xAI job ${outcome.jobId} did not produce a saved video: ${outcome.message}${recovery}${cost} It was not resubmitted, to avoid a second charge.`,
					{ ...base, jobId: outcome.jobId, videoUrl: outcome.videoUrl, costUsd: outcome.costUsd },
					true,
				);
			}

			const target = outputPath ?? path.join(ctx.cwd, `xai-video-${outcome.jobId.replace(/[^\w.-]/g, "_")}.mp4`);
			const shown = displayPath(target, ctx.cwd);
			const details: VideoToolDetails = {
				...base,
				jobId: outcome.jobId,
				videoUrl: outcome.videoUrl,
				costUsd: outcome.costUsd,
			};
			try {
				await Bun.write(target, outcome.video);
			} catch (error) {
				const reason = sanitizeMessage(String(error)).replaceAll(os.homedir(), "~");
				return textResult(
					`xAI job ${outcome.jobId} finished but writing ${shown} failed (${reason}). The video is still downloadable at ${outcome.videoUrl}${cost}`,
					details,
					true,
				);
			}
			const seconds = Math.round((Date.now() - startedAt) / 1000);
			const megabytes = (outcome.video.byteLength / 1_048_576).toFixed(1);
			return textResult(
				`Generated video with ${credentials.provider}/${model} (job ${outcome.jobId}) in ${seconds}s. Saved to ${shown} (${megabytes} MB, ${outcome.contentType}).${cost}`,
				{ ...details, path: target, bytes: outcome.video.byteLength },
			);
		},
	});
}
