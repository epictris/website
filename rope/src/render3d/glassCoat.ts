// The aurora film's two numbers (see glassMaterial.ts, "THE AURORA COATING"),
// on their own so the broken pieces' worker (render/glassShardsWorker.ts) can
// read them without loading three.js.

// The film's index and the thickness it runs between, pole to pole, along the
// ball's own axis, so the bands roll with the ball.
//
// HALF AS STRONG (Tris, 2026-10-16: "tone down the aurora effect - maybe
// 50%"), by the film's material rather than by scaling what it does: how much
// a film reflects at its strongest (a quarter wave) is
// ((n_glass - n_film^2) / (n_glass + n_film^2))^2, and how far that rises
// above bare quartz (4.6%) is how strong its colours are. Titania (2.3) peaks
// at 30%; a film of 1.94 - silicon nitride or zirconia, both evaporated onto
// optics - peaks at 17.5%, half the rise. Its thickness is titania's times
// 2.3 / 1.94, the same OPTICAL thickness, so the bands keep their colours
// and only lose strength.
export const COAT_IOR = 1.94;
export const COAT_THICKNESS_NM: readonly [number, number] = [142, 332];
