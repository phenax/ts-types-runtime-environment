import { Type } from 'ts-morph'
import { promises as fs } from 'fs'
import readline from 'readline'

import { match } from './util'
import { Ctx } from './types'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
})

export const cleanup = () => {
  rl.close()
}

const readLineFromStdin = (): Promise<string> =>
  new Promise((res) => rl.on('line', res))

export const evaluateType = async (
  ctx: Ctx,
  effTyp: Type
): Promise<string[]> => {
  const name = effTyp.getSymbol()?.getName()
  const args = effTyp.getTypeArguments()

  // console.log(ctx.typeToString(effTyp))
  // console.log(name, args.map(ctx.typeToString))

  return match(name, {
    DefineEffect: async () => {
      const [nameTyp, exprTyp] = args
      const name = nameTyp?.getLiteralValue() as string
      const exprStr = exprTyp?.getLiteralValue() as string

      ctx.addCustomEffect(name, exprStr)
      return []
    },

    CreateRef: async () => {
      const val = ctx.typeToString(args[0])
      const refKey = ctx.createRef(val)
      const [resultKey, _] = ctx.createResult(JSON.stringify(refKey))
      return [resultKey]
    },

    GetRef: async () => {
      const refKey = ctx.getTypeValue(args[0])
      const val = ctx.getRef(refKey)
      if (!val) throw new Error('Ref has been deleted')
      const [resultKey, _] = ctx.createResult(val)
      return [resultKey]
    },

    SetRef: async () => {
      const [ keyTy, valTyp ] = args
      ctx.setRef(ctx.getTypeValue(keyTy), ctx.typeToString(valTyp))
      return []
    },

    DeleteRef: async () => {
      ctx.deleteRef(ctx.getTypeValue(args[0]))
      return []
    },

    Pure: async () => {
      const [valTyp] = args
      const [resultKey, _] = ctx.createResult(ctx.typeToString(valTyp))
      return [resultKey]
    },

    Print: async () => {
      console.log(...args.map(ctx.typeToString))
      return []
    },

    PutString: async () => {
      const [strinTyp] = args
      const typString = ctx.getTypeValue(strinTyp) ?? ctx.typeToString(strinTyp)
      process.stdout.write(typString)
      return []
    },

    Debug: async () => {
      const [labelTyp, valueTyp] = args
      const label = ctx.getTypeValue(labelTyp)
      const value = ctx.typeToString(valueTyp)
      console.log(label, value)
      const [resultKey, _] = ctx.createResult(JSON.stringify(value))
      return [resultKey]
    },

    ReadFile: async () => {
      const [pathTyp] = args
      const filePath = ctx.getTypeValue(pathTyp)
      const contents = await fs.readFile(filePath, 'utf-8')
      const [resultKey, _] = ctx.createResult(JSON.stringify(contents))
      return [resultKey]
    },

    WriteFile: async () => {
      const [pathTyp, contentsTyp] = args
      const filePath = ctx.getTypeValue(pathTyp)
      const contents = ctx.getTypeValue(contentsTyp)
      await fs.writeFile(filePath, contents)
      return []
    },

    Bind: async () => {
      const [inputTyp, chainToKind] = args
      const [resultKey] = inputTyp ? await evaluateType(ctx, inputTyp) : []

      // TODO: Handle resultKey undefined case
      const [_, compNode] = ctx.createResult(
        `(${ctx.typeToString(chainToKind)} & { input: (${ctx.getResultExpr(
          resultKey
        )})['output'] })['return']`
      )
      // TODO: Avoid using getTypeAtLocation?
      const compTyp = compNode
        ?.getType()
        .getProperty('output')
        ?.getTypeAtLocation(ctx.entryPoint)

      return compTyp ? await evaluateType(ctx, compTyp) : []
    },

    GetEnv: async () => {
      const [envTyp] = args
      const envName = ctx.getTypeValue(envTyp)
      const [resultKey, _] = ctx.createResult(
        `${JSON.stringify(process.env[envName] ?? '')}`
      )
      return [resultKey]
    },

    GetArgs: async () => {
      const [resultKey, _] = ctx.createResult(
        `${JSON.stringify(process.argv.slice(2))}`
      )
      return [resultKey]
    },

    Exit: async () => {
      process.exit(args[0] && ctx.getTypeValue(args[0]))
    },

    Try: async () => {
      const [effTyp, catchK] = args

      try {
        if (!effTyp) throw new Error('wow')
        return await evaluateType(ctx, effTyp)
      } catch(e) {
        const error = JSON.stringify((e as any)?.message ?? e)
        const catchResExpr = `(${ctx.typeToString(catchK)} & { input: ${error} })['return']`
        const [resultKey, _] = ctx.createResult(catchResExpr)
        return [resultKey]
      }
    },

    Throw: async () => {
      throw args[0] && ctx.getTypeValue(args[0])
    },

    ReadLine: async () => {
      const line = await readLineFromStdin()
      const [resultKey, _] = ctx.createResult(`${JSON.stringify(line)}`)
      return [resultKey]
    },

    JsExpr: async () => {
      const [exprTyp] = args
      const exprStr = ctx.getTypeValue(exprTyp)
      const result = eval(`JSON.stringify(${exprStr})`)
      const [resultKey, _] = ctx.createResult(`${result}`)
      return [resultKey]
    },

    Seq: async () => {
      const [effectTyps] = args
      const effectResults = await evalList(
        ctx,
        effectTyps?.getTupleElements() ?? []
      )
      const [resultKey, _] = ctx.createResult(`[
        ${effectResults.map(ctx.getResultExpr).join(', ')}
      ]`)
      return [resultKey]
    },

    Do: async () => {
      const [effectTyps] = args
      const effectResults = await evalList(
        ctx,
        effectTyps?.getTupleElements() ?? []
      )
      // TODO: Use last type's result instead of last result key
      const lastResKey = effectResults[effectResults.length - 1]
      const [resultKey, _] = ctx.createResult(
        `(${ctx.getResultExpr(lastResKey)})['output']`
      )
      return [resultKey]
    },

    _: async () => {
      if (name && ctx.hasCustomEffect(name)) {
        return ctx.runCustomEffect(name, args)
      }

      console.log(`${name} effect is not handled`)
      console.log(ctx.typeToString(effTyp))
      // TODO: Maybe throw?
      return []
    },
  })
}

export const evalList = async (ctx: Ctx, effectTyps: Type[]) => {
  const effectResults: string[] = []
  for (const item of effectTyps ?? []) {
    effectResults.push(...(await evaluateType(ctx, item)))
  }
  return effectResults
}
