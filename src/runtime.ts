import { Project, ScriptTarget, Type, Node, StringLiteral, TypeFormatFlags, SyntaxKind } from 'ts-morph'
import path from 'path'
import { promises as fs } from 'fs'

const project = new Project({
  compilerOptions: {
    target: ScriptTarget.ES3,
  },
})

const typeChecker = project.getTypeChecker()

const sourceFile = project.addSourceFileAtPath(path.resolve("./src/index.ts"))

const entryPoint = sourceFile.getExportedDeclarations().get('main')?.[0]

const typeToString = (ty: Type | undefined): string =>
  ty ? typeChecker.compilerObject.typeToString(ty.compilerType) : ''

const getPropertyType = (n: Node, prop: string): Type | undefined => {
  const tt = typeChecker.getTypeAtLocation(n)
  const propSym = tt.getProperty(prop)
  const ty = propSym && typeChecker.getTypeOfSymbolAtLocation(propSym, n)
  return ty
}

const typeRefNode = entryPoint?.getLastChild()

const RESULT_TYPE_NAME = '__$result'

const [statement] = sourceFile.addStatements(`type ${RESULT_TYPE_NAME} = {}`)

const addResult = (name: string, ty: string) => {
  if (statement.isKind(SyntaxKind.TypeAliasDeclaration)) {
    const value = statement.getChildAtIndex(3)
    if (value.isKind(SyntaxKind.TypeLiteral)) {
      value.addProperty({
        name: JSON.stringify(name),
        type: `{ output: ${ty} }`,
      })
    }
  }
}

const createHash = () =>
  Math.random().toFixed(8).slice(2)

const match = <K extends string, R>(k: K | undefined, pattern: { [key in K | '_']: () => R }) =>
  k && pattern[k] ? pattern[k]() : pattern._()

const accumulateResults = async (effTyp: Type, node: Node): Promise<string[]> => {
  const name = effTyp.getSymbol()?.getName()

  return match(name, {
    ReadFile: async () => {
      const [pathTyp] = effTyp.getTypeArguments()
      const filePath = JSON.parse(typeToString(pathTyp))
      const contents = await fs.readFile(filePath, 'utf-8')
      const hash = createHash()
      addResult(hash, JSON.stringify(contents))
      return [hash]
    },

    ChainIO: async () => {
      const inputTyp = effTyp.getProperty('input')?.getTypeAtLocation(node)
      const inputResults = inputTyp && await accumulateResults(inputTyp, node)
      return inputResults ?? []
    },

    GetEnv: async () => {
      const [envTyp] = effTyp.getTypeArguments()
      const envName = JSON.parse(typeToString(envTyp))
      const hash = createHash()
      addResult(hash, `${JSON.stringify(process.env[envName] ?? '')}`)
      return [hash]
    },

    _: async () => {
      console.log(`${name} result effect is unhandled`)
      return []
    },
  })
}

const evalAccumulator = async (effNode: Node, node: Node) => {
  const effTyp = effNode.getType()
  const name = effTyp.getSymbol()?.getName()

  return match(name, {
    Print: async () => {
      console.log(...effTyp.getTypeArguments().map(typeToString));
    },

    ReadFile: async () => {
      const [hash] = await accumulateResults(effTyp, node)
      effNode.replaceWithText(`${RESULT_TYPE_NAME}[${JSON.stringify(hash)}]`)
    },

    WriteFile: async () => {
      const [pathTyp, contentsTyp] = effTyp.getTypeArguments()
      const filePath = JSON.parse(typeToString(pathTyp))
      const contents = JSON.parse(typeToString(contentsTyp))
      await fs.writeFile(filePath, contents)
    },

    ChainIO: async () => {
      const inputTyp = effTyp.getProperty('input')?.getTypeAtLocation(node)
      const chainToKind = effTyp.getProperty('chainTo')?.getTypeAtLocation(node)
      const [hashRes] = inputTyp ? await accumulateResults(inputTyp, node) : []
      const chainRes = `(${typeToString(chainToKind)} & { input: ${RESULT_TYPE_NAME}[${JSON.stringify(hashRes)}]['output'] })['return']`
      const updateEffNode = effNode.replaceWithText(chainRes)
      await evalAccumulator(updateEffNode, node)
    },

    _: async () => {
      console.log(effNode.print())
      console.log('TTTT', typeToString(effTyp))
      console.log(`${name} effect is unhandled`)
    }
  })
}

const main = async () => {
  if (typeRefNode) {
    const resultType = entryPoint?.getType()

    if (typeRefNode && entryPoint && resultType?.getSymbol()?.getName() === 'Program') {
      const exitCodeTy = getPropertyType(typeRefNode, 'exitCode')
      const effectTypes = getPropertyType(typeRefNode, 'effects')
      if (effectTypes?.isTuple()) {
        const effectNodes = entryPoint.getChildrenOfKind(SyntaxKind.TypeReference)
          .flatMap(n => n.getChildrenOfKind(SyntaxKind.TupleType))
          .flatMap(tt => tt.getChildrenOfKind(SyntaxKind.SyntaxList))
          .flatMap(n => n.getChildren())
          .filter(n => !n.isKind(SyntaxKind.CommaToken))

        for (const n of effectNodes) {
          await evalAccumulator(n, typeRefNode)
        }
      }

      const exitCode = exitCodeTy?.getLiteralValue() as number

      if (exitCode !== 0) {
        process.exit(exitCode)
      }
    } else {
      const ty = typeChecker.getTypeAtLocation(typeRefNode)
      console.log(typeToString(ty))
    }
  }
}

main()
  .then(() => {
    // console.log(entryPoint?.print())
    // console.log(statement?.print())
    process.exit(0)
  })
  .catch(e => (console.error(e), process.exit(1)))

