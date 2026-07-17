# Segurança

- Nunca envie `service_role`, token da Meta ou tokens internos ao GitHub.
- O frontend contém somente URL e chave `anon` do Supabase; o RLS limita cada usuário aos próprios dados.
- O Worker usa segredos criptografados do Cloudflare.
- O sistema exige consentimento, permite descadastro e bloqueia contatos inativos.
- O Modo Custo Zero bloqueia envios fora da janela de atendimento iniciada pelo cliente.
- Não existe simulação de presença, digitação, spintax antidetecção ou biblioteca não oficial.
- Rotacione imediatamente qualquer segredo que apareça em print, log ou commit.

Para reportar uma vulnerabilidade, não abra uma issue pública contendo segredos ou dados pessoais.

