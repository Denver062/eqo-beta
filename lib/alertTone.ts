// Lightweight wrapper to play alert tones with pitch-shift while keeping speed
// Uses Tone.js PitchShift effect, loaded dynamically to avoid SSR issues

export interface PlayAlertToneOptions {
	src: string; // public path to audio
	cutMs: number; // milliseconds to stop playback
	semitones?: number; // pitch shift in semitones (+ up)
	volume?: number; // linear 0..1
	gain?: number; // linear >= 1 (post gain boost)
}

const linearToDb = (v: number): number => {
	const val = Math.max(0.0001, Math.min(1, v));
	return 20 * Math.log10(val);
};

export async function playAlertTone(options: PlayAlertToneOptions): Promise<void> {
    const { src, cutMs, semitones = 0, volume = 0.5, gain = 1 } = options;
	try {
		const Tone = await import('tone');
		// Ensure audio context is started (requires a user gesture before in page)
		await (Tone as any).start?.();

        const player = new (Tone as any).Player({ url: src, autostart: false });
        const shifter = new (Tone as any).PitchShift({ pitch: semitones });
        const gainNode = new (Tone as any).Gain(gain);
        player.connect(shifter).connect(gainNode).toDestination();
		// Set volume in dB
		try { player.volume.value = linearToDb(volume); } catch {}

		player.start();
		await new Promise<void>(resolve => setTimeout(resolve, cutMs));
        try { player.stop(); } catch {}
        try { player.dispose?.(); shifter.dispose?.(); gainNode.dispose?.(); } catch {}
		return;
	} catch (_) {
		// Fallback: plain HTMLAudio without independent pitch
		return new Promise<void>((resolve) => {
			const audio = new Audio(src);
            audio.volume = Math.min(1, volume * Math.max(1, gain));
			audio.play().catch(() => {});
			setTimeout(() => {
				try { audio.pause(); audio.currentTime = 0; } catch {}
				resolve();
			}, cutMs);
		});
	}
}


