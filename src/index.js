import queryString from 'query-string';

import * as photon from '@silvia-odwyer/photon';
import PHOTON_WASM from '../node_modules/@silvia-odwyer/photon/photon_rs_bg.wasm';

import encodeWebp, { init as initWebpWasm } from '@jsquash/webp/encode';
import WEBP_ENC_WASM from '../node_modules/@jsquash/webp/codec/enc/webp_enc.wasm';

// 图片处理
const photonInstance = await WebAssembly.instantiate(PHOTON_WASM, {
	'./photon_rs_bg.js': photon,
});
photon.setWasm(photonInstance.exports); // need patch

await initWebpWasm(WEBP_ENC_WASM);

const OUTPUT_FORMATS = {
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
};

const multipleImageMode = ['watermark', 'blend'];

const inWhiteList = (env, url) => {
	const imageUrl = new URL(url);
	const whiteList = env.WHITE_LIST ? env.WHITE_LIST.split(',') : [];
	return !(whiteList.length && !whiteList.find((hostname) => imageUrl.hostname.endsWith(hostname)));
};

const processImage = async (env, request, inputImage, pipeAction) => {
	const [action, options = ''] = pipeAction.split('!');
	const params = options.split(',');
	if (typeof photon[action] !== 'function') {
		throw new Error(`Unsupported action: ${action}`);
	}
	if (action === 'resize') {
		// resize 参数转为数字
		const [w, h, interp] = params.map(Number);
		const beforeW = inputImage.get_width();
		const beforeH = inputImage.get_height();
		const resized = photon.resize(inputImage, w, h, interp);
		const afterW = resized.get_width();
		const afterH = resized.get_height();
		console.log('[resize]', 'from', beforeW, beforeH, 'to', w, h, 'interp', interp, 'result', afterW, afterH);
		return resized;
	}
	if (multipleImageMode.includes(action)) {
		const image2 = params.shift();
		const image2Url = image2 ? decodeURIComponent(image2) : '';
		if (image2Url && inWhiteList(env, image2Url)) {
			const image2Res = await fetch(image2Url, { headers: request.headers });
			if (image2Res.ok) {
				const inputImage2 = photon.PhotonImage.new_from_byteslice(new Uint8Array(await image2Res.arrayBuffer()));
				try {
					photon[action](inputImage, inputImage2, ...params);
				} finally {
					inputImage2.ptr && inputImage2.free && inputImage2.free();
				}
				return inputImage; // 多图模式返回第一张图
			}
		}
	} else {
		return photon[action](inputImage, ...params);
	}
	};

export default {
	async fetch(request, env, context) {
		// 读取缓存
		const cacheUrl = new URL(request.url);
		const cacheKey = new Request(cacheUrl.toString());
		const cache = caches.default;
		const hasCache = await cache.match(cacheKey);
		if (hasCache) {
			console.log('cache: true');
			return hasCache;
		}

		// 入参提取与校验
		const query = queryString.parse(new URL(request.url).search);
		const { url = '', action = '', format = 'webp', quality = 99 } = query;
		const qualityNum = Number(quality) || 99;
		console.log('params:', url, action, format, qualityNum);
		if (!url) {
			return new Response(null, {
				status: 404,
			});
		}

		// 白名单检查
		if (!inWhiteList(env, url)) {
			console.log('whitelist: false');
			return new Response(null, {
				status: 403,
			});
		}

		// 目标图片获取与检查
		const imageRes = await fetch(url, { headers: request.headers });
		if (!imageRes.ok) {
			return imageRes;
		}
		const contentLength = imageRes.headers.get('content-length');
		if (contentLength && Number(contentLength) > 8 * 1024 * 1024) { // 8MB 限制
			return new Response('Image too large', { status: 413 });
		}
		console.log('fetch image done', imageRes.status, imageRes.headers.get('content-type'), contentLength);

		const imageBytes = new Uint8Array(await imageRes.arrayBuffer());
		if (imageBytes.length > 8 * 1024 * 1024) {
			return new Response('Image too large', { status: 413 });
		}
		let inputImage, outputImage;
		try {
			inputImage = photon.PhotonImage.new_from_byteslice(imageBytes);
			console.log('create inputImage done');

			/** pipe
			 * `resize!800,400,1|watermark!https%3A%2F%2Fmt.ci%2Flogo.png,10,10,10,10`
			 */
			const pipe = action.split('|');
			outputImage = await pipe.filter(Boolean).reduce(async (result, pipeAction) => {
				// 释放上一个中间态，避免内存堆积
				const prev = await result;
				let next;
				try {
					next = await processImage(env, request, prev, pipeAction);
				} finally {
					if (prev && prev !== inputImage && prev.ptr && prev.free) {
						try { prev.free(); } catch (e) { /* ignore */ }
					}
				}
				return next || prev;
			}, Promise.resolve(inputImage));
			console.log('create outputImage done');


			// 图片编码前加宽高和像素数限制，防止 webp 编码 OOM
			let outputImageData;
			const width = outputImage.get_width();
			const height = outputImage.get_height();
			if (format === 'webp') {
				if (width * height > 16 * 1024 * 1024 || width > 8000 || height > 8000) {
					return new Response('Image dimensions too large for webp', { status: 413 });
				}
				outputImageData = await encodeWebp(outputImage.get_image_data(), { quality: qualityNum });
			} else if (format === 'jpeg' || format === 'jpg') {
				outputImageData = outputImage.get_bytes_jpeg(qualityNum)
			} else if (format === 'png') {
				outputImageData = outputImage.get_bytes()
			}
			console.log('create outputImageData done', outputImageData && outputImageData.length);

			if (!outputImageData) {
				console.error('outputImageData is empty or undefined');
				return new Response('Image encode failed', { status: 500 });
			}

			// 返回体构造
			const imageResponse = new Response(outputImageData, {
				headers: {
					'content-type': OUTPUT_FORMATS[format],
					'cache-control': 'public,max-age=15552000,s-maxage=15552000',
				},
			});

			// 释放资源
			if (inputImage && inputImage.ptr && inputImage.free) {
				try { inputImage.free(); } catch (e) { /* ignore */ }
			}
			if (outputImage && outputImage.ptr && outputImage.free && outputImage !== inputImage) {
				try { outputImage.free(); } catch (e) { /* ignore */ }
			}
			console.log('image free done');

			// 写入缓存
			context.waitUntil(cache.put(cacheKey, imageResponse.clone()));
			return imageResponse;
		} catch (error) {
			console.error('process:error', error.name, error.message, error);
			if (inputImage && inputImage.ptr && inputImage.free) {
				try { inputImage.free(); } catch (e) { /* ignore */ }
			}
			if (outputImage && outputImage.ptr && outputImage.free && outputImage !== inputImage) {
				try { outputImage.free(); } catch (e) { /* ignore */ }
			}
			const errorResponse = new Response(imageBytes || null, {
				headers: imageRes.headers,
				status: 'RuntimeError' === error.name ? 415 : 500,
			});
			return errorResponse;
		}
	},
};
