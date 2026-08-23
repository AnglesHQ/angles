const debug = require('debug');
const SharedStep = require('../models/shared-step.js');

const log = debug('manual-step:utils');
const manualStepUtils = {};

/*
Returns the ids of every shared step referenced by a list of steps.
 */
manualStepUtils.collectSharedStepIds = (steps) => {
  const ids = (steps || [])
    .filter((step) => step.sharedStep)
    .map((step) => step.sharedStep.toString());
  return Array.from(new Set(ids));
};

/*
Expands every shared-step placeholder in a list of steps into the steps it references,
flattening the result and renumbering `order` so it stays contiguous.

Expansion is deliberately a *copy*. Each expanded step carries `sharedStepRef` and
`sharedStepVersion` for display attribution, but it is a literal step - not a reference
that could resolve to something else later. That is what lets a frozen version store the
expanded form and stay immune to later edits of the shared step.

An expanded step keeps the shared step's own `_id`, so a recorded step result binds to a
stable identity across cases that include the same shared step at the same version.

A placeholder whose shared step no longer exists is preserved as a literal step rather
than dropped: silently losing steps from a test case would be far worse than showing one
that is flagged as unresolved. `unresolvedSharedStep` marks it so the UI can say so.
 */
manualStepUtils.expandSteps = (steps, sharedStepsById) => {
  const expanded = [];

  (steps || []).forEach((step) => {
    // Mongoose subdocuments need converting before spreading, plain objects do not.
    const plain = typeof step.toObject === 'function' ? step.toObject() : { ...step };

    if (!plain.sharedStep) {
      expanded.push(plain);
      return;
    }

    const sharedStep = sharedStepsById.get(plain.sharedStep.toString());
    if (!sharedStep) {
      log(`Shared step ${plain.sharedStep} referenced by a test case no longer exists; keeping the placeholder.`);
      expanded.push({
        ...plain,
        sharedStep: undefined,
        sharedStepRef: plain.sharedStep,
        unresolvedSharedStep: true,
        action: plain.action || 'Unresolved shared step',
      });
      return;
    }

    (sharedStep.steps || []).forEach((sharedStepStep) => {
      const sharedPlain = typeof sharedStepStep.toObject === 'function'
        ? sharedStepStep.toObject()
        : { ...sharedStepStep };
      expanded.push({
        ...sharedPlain,
        // The expanded step is literal: it must not itself be a reference.
        sharedStep: undefined,
        sharedStepRef: sharedStep._id,
        sharedStepVersion: sharedStep.version,
      });
    });
  });

  // Renumber so order is contiguous regardless of how many steps each inclusion produced.
  return expanded.map((step, index) => ({ ...step, order: index + 1 }));
};

/*
Loads the shared steps a list of steps references and expands them.

Returns the steps unchanged when nothing references a shared step, which is the common
case and avoids a pointless query.
 */
manualStepUtils.expandStepsFor = async (steps) => {
  const ids = manualStepUtils.collectSharedStepIds(steps);
  if (ids.length === 0) {
    return (steps || []).map((step) => (
      typeof step.toObject === 'function' ? step.toObject() : { ...step }
    ));
  }
  const sharedSteps = await SharedStep.find({ _id: { $in: ids } }).lean().exec();
  const byId = new Map(sharedSteps.map((sharedStep) => [sharedStep._id.toString(), sharedStep]));
  return manualStepUtils.expandSteps(steps, byId);
};

module.exports = manualStepUtils;
