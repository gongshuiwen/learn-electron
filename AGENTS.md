# AGENTS.md

## 会话

- 遵循格赖斯合作原则及四项会话准则：信息充分而不冗余，论述真实且有依据，回应紧扣问题，表达清晰有序；不以简洁为由牺牲准确性和必要深度。

## 开发

- 保持代码、测试和文档简洁，避免冗余、重复和过度设计；按职责组织结构，降低耦合，避免循环依赖。
- 功能迁移时同步清理无用代码和样式。
- 仅做与本次变更直接相关的必要小范围重构；范围外的高价值架构改进，说明问题、预期收益和影响范围，不自行扩大修改范围。
- 随变更审查受影响的文档，优先维护现有权威来源；具体流程遵循 [documentation-baseline-maintenance Skill](.agents/skills/documentation-baseline-maintenance/SKILL.md)。

## 测试

- 修改代码、契约或影响运行的配置与脚本时，同步审查受影响的测试；优先维护现有基线，具体流程遵循 [test-baseline-maintenance Skill](.agents/skills/test-baseline-maintenance/SKILL.md)。
- 保留有效契约、关键回归、模块联动和相关只读行为约束的验证。
- 按改动影响选择测试、类型、lint 和格式检查；影响面广或交付有要求时扩大验证。

## 参考

- 模块、配置、数据归属和生命周期参见 [整体架构](docs/architecture.md)，依赖边界见 [.oxlintrc.json](.oxlintrc.json)与[后端模块检查](scripts/check-server-modules.mjs)。
- HTTP/SSE 行为参见 [前后端协议](docs/protocol.md)，类型与校验见 [HTTP 契约](packages/contracts/src/index.ts)和[原生桥契约](packages/contracts/src/native.ts)。
- 环境与运行命令参见 [README](README.md)与[根脚本](package.json)。
- 测试准备与执行参见 [测试指南](docs/testing.md)。
