/**
 * Shared abort signal — a process-wide singleton.
 *
 * Any module can import this and either:
 *   - call abort()     to request cancellation (Escape key handler)
 *   - call isAborted() to check at safe boundaries (step loop, retry loop)
 *   - call reset()     to clear the flag before a new query
 */

let aborted = false;

module.exports = {
  reset()     { aborted = false; },
  abort()     { aborted = true;  },
  isAborted() { return aborted;  },
};
