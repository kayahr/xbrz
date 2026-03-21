# Changelog

## [1.1.2] - 2026-03-21

### Changed
- Initialize the Y'CbCr lookup table eagerly during scaler setup.
- Also publish to jsr.io and change README.md accordingly.

## [1.1.1] - 2026-03-21

### Changed
- Update README.

### Fixed
- Fix broken links in CHANGELOG.

## [1.1.0] - 2026-03-21

### Added
- Add `largeLut` option to switch to larger 8-bit precision LUT.

### Changed
- Use smaller 5-bit precision LUT (128 KiB) instead of larger 8-bit precision LUT (64 MiB) by default.

[Unreleased]: https://github.com/kayahr/xbrz/compare/v1.1.2...HEAD
[1.1.2]: https://github.com/kayahr/xbrz/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/kayahr/xbrz/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/kayahr/xbrz/compare/v1.0.0...v1.1.0
