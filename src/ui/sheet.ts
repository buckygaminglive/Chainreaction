/**
 * Bottom sheets: drag-to-dismiss for the overlay panels.
 *
 * The overlays were centred cards with a close button in a corner — a desktop
 * pattern. On a phone the corner is the furthest point from the thumb, and a
 * card floating in the middle of a dimmed screen gives no clue that it can be
 * put away by hand. A sheet anchored to the bottom edge, with a handle and a
 * downward drag, is the pattern people already know from every other app on
 * the device.
 *
 * The behaviour that matters is the one nobody notices when it is right:
 *
 *   A sheet that scrolls must not dismiss when the player is scrolling it.
 *   A drag only becomes a dismissal if the content is already at the top,
 *   so pulling down through a long profile scrolls it, and pulling down again
 *   once it will not scroll further closes it. Getting this wrong is what
 *   makes a sheet feel like it is fighting you.
 *
 * Only vertical intent counts, so a horizontal swipe inside the sheet — the
 * avatar row, the mode grid — is never mistaken for a dismissal.
 */

export interface SheetOptions {
  /** The scrim/screen element; taps on it outside the sheet dismiss. */
  screen: HTMLElement;
  /** The panel that actually moves. */
  sheet: HTMLElement;
  /** Invoked when the player has asked for it to go away. */
  onDismiss: () => void;
}

/** Past this fraction of the sheet's height, releasing dismisses. */
const DISMISS_FRACTION = 0.28;
/** Or past this speed, regardless of distance — a flick should work even if
 *  it never travelled far. Pixels per millisecond. */
const DISMISS_VELOCITY = 0.55;
/** Movement below this is a tap, not a drag; used to avoid stealing taps. */
const DRAG_SLOP = 6;

/** Sheets are a phone pattern. On a wide screen the centred card is right, and
 *  a drag gesture on a mouse is not something anyone asks for. */
function sheetsActive(): boolean {
  return window.matchMedia('(max-width: 699px)').matches;
}

/**
 * Resistance past the end of the travel.
 *
 * Dragging up should not lift the sheet off the bottom of the screen, but a
 * hard stop feels broken. The pull is allowed, heavily damped, so it reads as
 * the sheet resisting rather than as the gesture failing.
 */
function damp(dy: number): number {
  return dy >= 0 ? dy : -Math.sqrt(-dy * 8);
}

export function attachSheet({ screen, sheet, onDismiss }: SheetOptions) {
  let startY = 0;
  let startX = 0;
  let dragging = false;
  let decided = false;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;

  const setOffset = (px: number | null) => {
    if (px === null) {
      sheet.style.transform = '';
      sheet.style.transition = '';
      return;
    }
    // No transition while the finger is down: the sheet should track it
    // exactly, and easing a value that is already following a finger reads as
    // lag.
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${px}px)`;
  };

  const settle = (dismiss: boolean) => {
    sheet.style.transition = '';
    if (dismiss) {
      sheet.style.transform = `translateY(${sheet.offsetHeight}px)`;
      // Let the slide finish before the screen is torn down, otherwise the
      // sheet vanishes mid-gesture and the dismissal has no follow-through.
      window.setTimeout(() => {
        sheet.style.transform = '';
        onDismiss();
      }, 180);
    } else {
      sheet.style.transform = '';
    }
  };

  sheet.addEventListener(
    'pointerdown',
    (e) => {
      if (!sheetsActive() || e.pointerType === 'mouse') return;
      // A drag starting on a control is that control's business.
      if ((e.target as HTMLElement).closest('input, button, a, .range')) return;
      startY = lastY = e.clientY;
      startX = e.clientX;
      lastT = e.timeStamp;
      velocity = 0;
      dragging = true;
      decided = false;
    },
    { passive: true }
  );

  sheet.addEventListener(
    'pointermove',
    (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      const dx = e.clientX - startX;

      if (!decided) {
        if (Math.abs(dy) < DRAG_SLOP && Math.abs(dx) < DRAG_SLOP) return;
        // Horizontal intent, or a downward pull on content that can still
        // scroll up, belongs to the content rather than to the sheet.
        if (Math.abs(dx) > Math.abs(dy) || (dy > 0 && sheet.scrollTop > 0)) {
          dragging = false;
          return;
        }
        decided = true;
      }

      const dt = e.timeStamp - lastT;
      if (dt > 0) velocity = (e.clientY - lastY) / dt;
      lastY = e.clientY;
      lastT = e.timeStamp;

      setOffset(damp(dy));
    },
    { passive: true }
  );

  const release = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    if (!decided) return;
    const dy = e.clientY - startY;
    settle(dy > sheet.offsetHeight * DISMISS_FRACTION || velocity > DISMISS_VELOCITY);
  };

  sheet.addEventListener('pointerup', release, { passive: true });
  sheet.addEventListener('pointercancel', release, { passive: true });

  // Tapping the dimmed area outside the sheet is the other way people expect
  // to close one.
  screen.addEventListener('pointerdown', (e) => {
    if (!sheetsActive()) return;
    if (e.target === screen) onDismiss();
  });
}

export interface SwipePagerOptions {
  /** The element the swipe is measured on. */
  surface: HTMLElement;
  /** Called with -1 for a swipe that should go back, +1 to go forward. */
  onSwipe: (direction: -1 | 1) => void;
}

/** Below this the gesture is a tap or a scroll, not a page turn. */
const PAGE_SWIPE_MIN = 48;

/**
 * Horizontal swipe between pages.
 *
 * Paired with `attachSheet`, which deliberately ignores horizontal intent —
 * so on a paged sheet a sideways drag turns the page and a downward one puts
 * the sheet away, and neither has to know about the other.
 *
 * The vertical check is what keeps them honest: a gesture that travels further
 * down than across belongs to the sheet or the scroll, never here.
 */
export function attachSwipePager({ surface, onSwipe }: SwipePagerOptions) {
  let startX = 0;
  let startY = 0;
  let tracking = false;

  surface.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse') return;
      if ((e.target as HTMLElement).closest('button, input, a')) return;
      startX = e.clientX;
      startY = e.clientY;
      tracking = true;
    },
    { passive: true }
  );

  surface.addEventListener(
    'pointerup',
    (e) => {
      if (!tracking) return;
      tracking = false;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) < PAGE_SWIPE_MIN || Math.abs(dy) > Math.abs(dx)) return;
      // Swiping left moves forward, the direction the content travels.
      onSwipe(dx < 0 ? 1 : -1);
    },
    { passive: true }
  );

  surface.addEventListener('pointercancel', () => { tracking = false; }, { passive: true });
}
