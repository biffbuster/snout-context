# astropy: questions for a person to check

Written and checked by the model on 2026-11-09, before any run. Each answerable question names the commit that answers it; each unanswerable one was checked against git log for the window.

## Answerable
1. When the IERS-A table is stale and a conversion needs predictive values, does IERS_Auto still always raise, or does iers_degraded_accuracy apply?
   Answer: 9f4de8d6a6 "Apply iers_degraded_accuracy to stale IERS_Auto predictive values (#20256)"
2. Negative indices in WCS.slice were counted from the wrong end of the axis; what fixed that and what happened to sanitize_slices?
   Answer: 60c9c64c35 "Use simplify_basic_index to normalize slices in WCS.slice and SlicedLowLevelWCS, which fixes negative values not being interpreted relative to the end of the axes, and deprecate sanitize_slices"
3. Unsigned 64-bit image data came back shifted after a compressed FITS write and read; what was the fix?
   Answer: 98b363521d "Fix uint64 data being silently shifted by 2**63 on compressed FITS round-trip, and explicitly reject RICE_1/PLIO_1 with uint64 values that do not fit in 32 bits"
4. What does astropy.wcs.get_include do now if astropy was built against the system WCSLIB?
   Answer: a26c0e8adc "Make astropy.wcs.get_include raise an exception when astropy was built against system WCSLIB (#20048)"
5. Cutout2D.plot_on_original drew the cutout outline with the wrong extent; when was that fixed?
   Answer: 2c22da3a5c "fix Cutout2D.plot_on_original span"
6. Do we have a test that pickles a DataInfo object that isn't bound to a parent?
   Answer: caa5d6673c "Add regression test for unbound DataInfo pickling"
7. In the WCSAxes API code, why was the length check before removing the custom: prefix of an axis type taken out?
   Answer: 080ab52378 "Remove dead always-true length check before stripping the custom: prefix from axis_type_split"
8. Which method does the fast Lomb-Scargle implementation use by default, and when did it stop using fasper?
   Answer: 5304deabab "Change default LS fast algorithm from 'fasper' to 'lra'"
9. In the script that updates the what's new stats, how does it check that the page exists for an explicit path versus the default one?
   Answer: d96b816380 "Unify the page existence check across the explicit and default path cases"
10. structured_to_unstructured on a StructuredQuantity got its unit wrong; where was that fixed?
   Answer: 987d44ff3d "Fix unit extraction in structured_to_unstructured for StructuredQuantity"
11. Do masked arrays support numpy's new top_k function from the numpy 2.6 development version?
   Answer: 5aee789100 "BUG: support numpy.top_k (numpy 2.6.0dev) (utils.masked)"
12. Did comparing GCRS frames for equality get cheaper by avoiding a full array broadcast?
   Answer: a41cc1bb7b "Use broadcast_shapes instead of broadcast in GCRS equality checks"
13. VOTable null values in the fast converters were declared with the wrong integer widths; what changed?
   Answer: 5e39dece70 "fix: declare null_value as fixed-width types"
14. Why was the text_size computation dropped from the tick label alignment code in WCSAxes?
   Answer: d14e403a9c "Remove unused text_size computation in TickLabels._set_xy_alignments"
15. Why did we remove the special case for fitsio's cooldown period from the project configuration?
   Answer: ba7a7869f4 "DEP/CLN: cleanup now unnecessary special-casing for fitsio's cooldown period"

## Unanswerable in this history
1. Why was the FITS header parser rewritten in Rust?
2. When did astropy.table drop support for writing HDF5 files? (hard: a commit skips an HDF5 test when h5py is missing; it doesn't answer this)
3. Why did the cosmology module move its distance calculations to the GPU?
4. What broke when the bundled WCSLIB was upgraded to version 9.0?
5. Why are coordinate transformation results cached in Redis now?
6. When did astropy.time stop accepting Julian dates given as strings?
7. Why was the Lomb-Scargle periodogram split out into its own package?
8. Why did the default cosmology change to Planck 2023?
9. Why did we replace the VOTable XML parser with lxml?
10. When did convolution switch to using FFTW by default?
11. Why does the ECSV writer now emit YAML 1.2 headers?
12. Why did NDData stop supporting masks?
13. Why did Quantity printing switch to engineering notation by default?
14. Why was the units module ported to use pint internally?
15. When did coordinates add support for Mars-centered frames?
