type Font = 'Arial' | 'Verdana' | 'BriannesHand';

class BitmapFontManager {
	private static REPLACEMENT_CHAR = String.fromCharCode(65533);

	// Fonts where "Bold" is registered against the exact same source PNG/XML
	// as the regular weight (see preload() below) because no hand-drawn bold
	// variant exists. For these, add() dilates the glyph silhouette by a
	// couple of pixels before filling it, to approximate a bold weight
	// instead of silently rendering identical-looking "bold" text.
	private static FAUX_BOLD_FONTS: Font[] = ['BriannesHand'];

	static preload(scene: Phaser.Scene): void {
		const load = scene.load;

		load.bitmapFont('Verdana#FFFFFF', '/assets/fonts/Verdana.png', '/assets/fonts/Verdana.xml');
		load.image('VerdanaStroke#FFFFFF', '/assets/fonts/VerdanaStroke.png');

		load.bitmapFont('VerdanaBold#FFFFFF', '/assets/fonts/VerdanaBold.png', '/assets/fonts/VerdanaBold.xml');
		load.image('VerdanaBoldStroke#FFFFFF', '/assets/fonts/VerdanaBoldStroke.png');

		load.bitmapFont('ArialBold#FFFFFF', '/assets/fonts/ArialBold.png', '/assets/fonts/ArialBold.xml');

		// Registered under the "...Bold#FFFFFF" slot even though there's only
		// one real weight of this font - both call sites that use it
		// (PhaserFloatingText, PhaserAttributeBar) already pass bold: true,
		// so this avoids having to touch either call site's parameters, just
		// the font name string. No stroke texture provided yet - see the
		// graceful fallback in add() below, which skips the stroke rather
		// than throwing if BriannesHandBoldStroke#FFFFFF was never loaded.
		load.bitmapFont('BriannesHandBold#FFFFFF', '/assets/fonts/BriannesHand.png', '/assets/fonts/BriannesHand.xml');
	}

	static create(scene: Phaser.Scene): void {
		const bitmapCache = scene.cache.bitmapFont;

		bitmapCache.add('VerdanaStroke#FFFFFF', {
			data: bitmapCache.get('Verdana#FFFFFF').data,
			frame: null,
			texture: 'VerdanaStroke#FFFFFF',
		});

		bitmapCache.add('VerdanaBoldStroke#FFFFFF', {
			data: bitmapCache.get('VerdanaBold#FFFFFF').data,
			frame: null,
			texture: 'VerdanaBoldStroke#FFFFFF',
		});

		this.add(scene, 'Arial', true, false, '#000000');
	}

	static font(scene: Phaser.Scene, font: Font, bold: boolean, stroke: boolean, color: string): string {
		const key = font + (bold ? 'Bold' : '') + (stroke ? 'Stroke' : '') + color.toUpperCase();

		if (!scene.cache.bitmapFont.has(key)) {
			this.add(scene, font, bold, stroke, color);
		}

		return key;
	}

	static add(scene: Phaser.Scene, font: Font, bold: boolean, stroke: boolean, color: string): void {
		const key = font + (bold ? 'Bold' : '') + (stroke ? 'Stroke' : '') + color.toUpperCase();

		const sourceFillKey = `${font + (bold ? 'Bold' : '')}#FFFFFF`;

		const bitmapCache = scene.cache.bitmapFont;
		const textures = scene.textures;

		const sourceFillData = bitmapCache.get(sourceFillKey);
		const sourceFillTexture = textures.get(sourceFillData.texture);
		const sourceFillImage = sourceFillTexture.getSourceImage() as HTMLImageElement;
		const w = sourceFillImage.width;
		const h = sourceFillImage.height;

		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;

		const ctx = canvas.getContext('2d');

		// The mask actually used for the fill - either the real glyph atlas, or
		// the faux-bold dilation of it from above. Kept separate from `canvas`
		// (which gets recolored below) so the stroke synthesis further down can
		// dilate this same silhouette again, rather than the original thin one.
		let fillMask: HTMLImageElement | HTMLCanvasElement = sourceFillImage;

		if (bold && this.FAUX_BOLD_FONTS.includes(font)) {
			// No real bold glyph atlas exists for this font - approximate one by
			// stamping the regular glyphs at a ring of 1px offsets so overlapping
			// edges accumulate opacity and the silhouette reads as thicker, then
			// fill that dilated shape below exactly like a real bold source would be.
			const dilated = Phaser.Display.Canvas.CanvasPool.create2D(null, w, h);
			const dilatedCtx = dilated.getContext('2d');
			dilatedCtx.clearRect(0, 0, w, h);

			const offsets: [number, number][] = [
				[-1, 0], [1, 0], [0, -1], [0, 1],
				[-1, -1], [1, -1], [-1, 1], [1, 1],
			];
			for (const [dx, dy] of offsets) {
				dilatedCtx.drawImage(sourceFillImage, dx, dy, w, h);
			}
			dilatedCtx.drawImage(sourceFillImage, 0, 0, w, h);

			fillMask = dilated;
		}

		ctx.drawImage(fillMask, 0, 0, w, h);

		ctx.globalCompositeOperation = 'source-in';
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, w, h);
		ctx.globalCompositeOperation = 'source-over'; // default

		if (stroke) {
			const sourceStrokeKey = `${font + (bold ? 'Bold' : '') + (stroke ? 'Stroke' : '')}#FFFFFF`;

			if (bitmapCache.has(sourceStrokeKey)) {
				const sourceStrokeData = bitmapCache.get(sourceStrokeKey);
				const sourceFillTexture = textures.get(sourceStrokeData.texture);
				const sourceStrokeImage = sourceFillTexture.getSourceImage() as HTMLImageElement;

				const tempCanvas = Phaser.Display.Canvas.CanvasPool.create2D(null, w, h);

				const tempCtx = tempCanvas.getContext('2d');
				tempCtx.clearRect(0, 0, w, h);
				tempCtx.drawImage(canvas, 0, 0, w, h);

				ctx.drawImage(sourceStrokeImage, 0, 0, w, h);
				ctx.globalCompositeOperation = 'source-in';
				ctx.fillStyle = '#000';
				ctx.fillRect(0, 0, w, h);
				ctx.globalCompositeOperation = 'source-over'; // default
				ctx.drawImage(tempCanvas, 0, 0, w, h);

				Phaser.Display.Canvas.CanvasPool.remove(tempCanvas);
			} else {
				// No pre-made stroke texture for this font/weight - synthesize one
				// the same way bold gets synthesized above, by dilating fillMask
				// further so it pokes out past the colored fill, filling that ring
				// black (always black - stroke colour is never the text colour),
				// then drawing the already-colored fill back on top of it.
				const tempCanvas = Phaser.Display.Canvas.CanvasPool.create2D(null, w, h);
				const tempCtx = tempCanvas.getContext('2d');
				tempCtx.clearRect(0, 0, w, h);
				tempCtx.drawImage(canvas, 0, 0, w, h);

				const strokeMask = Phaser.Display.Canvas.CanvasPool.create2D(null, w, h);
				const strokeMaskCtx = strokeMask.getContext('2d');
				strokeMaskCtx.clearRect(0, 0, w, h);

				const strokeOffsets: [number, number][] = [
					[-1, 0], [1, 0], [0, -1], [0, 1],
					[-1, -1], [1, -1], [-1, 1], [1, 1],
				];
				for (const [dx, dy] of strokeOffsets) {
					strokeMaskCtx.drawImage(fillMask, dx, dy, w, h);
				}
				strokeMaskCtx.drawImage(fillMask, 0, 0, w, h);

				ctx.clearRect(0, 0, w, h);
				ctx.drawImage(strokeMask, 0, 0, w, h);
				ctx.globalCompositeOperation = 'source-in';
				ctx.fillStyle = '#000';
				ctx.fillRect(0, 0, w, h);
				ctx.globalCompositeOperation = 'source-over'; // default
				ctx.drawImage(tempCanvas, 0, 0, w, h);

				Phaser.Display.Canvas.CanvasPool.remove(tempCanvas);
				Phaser.Display.Canvas.CanvasPool.remove(strokeMask);
			}
		}

		// fillMask is only a pooled canvas (needs releasing) when bold synthesis
		// created one above; when it's just the original loaded image, there's
		// nothing to return to the pool.
		if (fillMask !== sourceFillImage) {
			Phaser.Display.Canvas.CanvasPool.remove(fillMask as HTMLCanvasElement);
		}

		textures.addCanvas(key, canvas);

		bitmapCache.add(key, {
			data: sourceFillData.data,
			frame: null,
			texture: key,
		});
	}

	static sanitize(fontData: Phaser.Types.GameObjects.BitmapText.BitmapFontData, text: string): string {
		for (let i = 0; i < text.length; i++) {
			if (!fontData.chars[text.charCodeAt(i)]) {
				text = text.substring(0, i) + this.REPLACEMENT_CHAR + text.substring(i + 1);
			}
		}

		return text;
	}
}
