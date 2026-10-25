// Hide automatic advisory dialogs without changing settings or required checks.
export function patchConfigDoctor(source) {
 const marker='// ArcaLink: recommendations must not open an automatic modal.';
 if(source.includes(marker))return source;
 const imported='import { performDoctorConsultation, RebuildOptions }';
 const anchor='    const { shouldRebuild, shouldRebuildLocal, isModified, settings } = await performDoctorConsultation(';
 if(source.split(imported).length!==2||source.split(anchor).length!==2)throw Error('Unexpected Config Doctor source');
 return source.replace(imported,'import { performDoctorConsultation, RebuildOptions, checkUnsuitableValues, RuleLevel }').replace(anchor,`    ${marker}
    if (!forceRescan && activateReason === "updated") {
        const issues = Object.values(checkUnsuitableValues(dependencies.settings).rules);
        if (issues.every(rule => rule && (rule.level === RuleLevel.Recommended || rule.level === RuleLevel.Optional))) {
            return true;
        }
    }
${anchor}`);
}
