import { Router } from 'express';

export function boardsRouter({ cli, config }) {
  const router = Router();

  router.get('/boards', async (req, res) => {
    let boards = await cli.listBoards();
    if (config.allowedFqbns.length) boards = boards.filter((b) => config.allowedFqbns.includes(b.fqbn));
    res.json({ boards });
  });

  return router;
}
