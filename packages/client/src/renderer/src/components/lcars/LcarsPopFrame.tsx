/**
 * The LCARS frame drawn around a pop-up (the soundboard): a small elbow at the top left that runs into a thin bar along
 * the top, and a rail down the left side. Decoration only; the pop-up's own content sits beside it.
 */
export function LcarsPopFrame() {
  return (
    <div className="lcars-popframe" aria-hidden="true">
      <span className="lcars-popframe-elbow" />
      <span className="lcars-popframe-bar" />
      <span className="lcars-popframe-cap" />
      <span className="lcars-popframe-rail" />
    </div>
  );
}
